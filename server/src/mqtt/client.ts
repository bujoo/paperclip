/**
 * Host-side MQTT singleton for the A2A-over-MQTT transport (Layer 0).
 *
 * Paperclip-managed agents do NOT each open their own broker connection.
 * Instead the host process owns one long-lived MQTT v5 connection and
 * multiplexes:
 *
 *  - Plugin workers' `ctx.mqtt.publish()` / `ctx.mqtt.on()` calls
 *    (RPC'd to the host via plugin-host-services).
 *  - The Agent Card projector's retained publishes on the discovery topics.
 *  - The bridge that forwards selected domain events to per-agent event topics.
 *
 * Only EXTERNAL A2A agents (running their own MQTT clients, registered via
 * the future `a2a_mqtt` adapter) carry their own `{companyId}/{circleId}/{agentId}`
 * Client ID and authenticate per-agent.
 *
 * Lifecycle:
 *  - `initMqtt()` — called once from server bootstrap.
 *  - `getClient()` — returns the connected client; throws if not initialised.
 *  - `publish()` / `subscribe()` — thin wrappers over the adapter helpers.
 *  - `shutdownMqtt()` — graceful disconnect on SIGINT/SIGTERM.
 *
 * The broker URL is read from `PAPERCLIP_MQTT_BROKER_URL` and defaults to
 * `mqtt://localhost:1883` for local dev (matches `docker/docker-compose.yml`).
 */

import {
  createA2AClient,
  publishEvent,
  publishRetained,
  subscribeRetained,
  type PublishEventOptions,
  type SubscribeHandler,
} from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";

/**
 * The connected mqtt.js client. We don't import the `MqttClient` type from
 * the `mqtt` package directly to avoid adding it as a direct server dep —
 * `@paperclipai/adapter-a2a-mqtt` already pulls it in. The structural shape
 * we use here is just the subset of methods `subscribeRetained` /
 * `publishEvent` accept, so we type it as `Awaited<ReturnType<typeof createA2AClient>>`.
 */
type MqttClient = Awaited<ReturnType<typeof createA2AClient>>;

/** Default broker URL when `PAPERCLIP_MQTT_BROKER_URL` is unset. */
const DEFAULT_BROKER_URL = "mqtt://localhost:1883";

/** Host singleton client identifier on the broker. */
const HOST_CLIENT_ID = "paperclip-host";

/** Reserved username for the host's own connection to the broker. The auth
 *  backend short-circuits this username and verifies against
 *  `PAPERCLIP_MQTT_HOST_PASSWORD` rather than the per-agent HMAC path. */
export const HOST_MQTT_USERNAME = "host:paperclip-server";

let _client: MqttClient | null = null;
let _initPromise: Promise<MqttClient> | null = null;
let _shuttingDown = false;

/** Active subscription handle, returned by subscribe() so callers can unwind. */
export interface MqttSubscriptionHandle {
  topicPattern: string;
  unsubscribe: () => Promise<void>;
}

/**
 * Lazily connect the host's singleton MQTT client. Idempotent — repeat
 * invocations return the same in-flight or resolved promise.
 *
 * On disconnect, mqtt.js's reconnectPeriod (1s, set by `createA2AClient`)
 * keeps trying. We surface connection lifecycle events to the logger so
 * operators can see broker outages without scraping a separate log stream.
 */
export async function initMqtt(opts: {
  brokerUrl?: string;
  username?: string;
  password?: string;
} = {}): Promise<MqttClient> {
  if (_client) return _client;
  if (_initPromise) return _initPromise;

  const brokerUrl =
    opts.brokerUrl ?? process.env.PAPERCLIP_MQTT_BROKER_URL?.trim() ?? DEFAULT_BROKER_URL;

  const username =
    opts.username ?? process.env.PAPERCLIP_MQTT_HOST_USERNAME?.trim() ?? HOST_MQTT_USERNAME;
  const password = opts.password ?? process.env.PAPERCLIP_MQTT_HOST_PASSWORD?.trim();

  logger.info({ brokerUrl, clientId: HOST_CLIENT_ID }, "Connecting host MQTT singleton");

  // Phase 1.6-bis: use `connect()` (synchronous) instead of `connectAsync()`
  // so we get a client reference immediately and mqtt.js's built-in
  // reconnect loop can drive recovery. Otherwise a single failed CONNACK
  // (e.g. EMQX's auth resource hasn't yet detected the server is back up)
  // would permanently disable the host singleton even though the broker is
  // ready seconds later.
  _initPromise = (async () => {
    const { connect: mqttConnect } = await import("mqtt");
    const client = mqttConnect(brokerUrl, {
      protocolVersion: 5,
      clientId: HOST_CLIENT_ID,
      username: username || undefined,
      password: password || undefined,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 2000,
      connectTimeout: 30_000,
    });

    _client = client;

    client.on("reconnect", () => {
      logger.info({ brokerUrl }, "MQTT host singleton reconnecting");
    });
    client.on("error", (err) => {
      logger.warn({ err: (err as Error)?.message }, "MQTT host singleton error");
    });
    client.on("offline", () => {
      logger.warn({ brokerUrl }, "MQTT host singleton offline");
    });
    client.on("close", () => {
      if (!_shuttingDown) {
        logger.warn({ brokerUrl }, "MQTT host singleton connection closed");
      }
    });
    client.on("connect", () => {
      logger.info({ brokerUrl }, "MQTT host singleton connected");
    });

    return client;
  })();

  return _initPromise;
}

/**
 * Return the connected host client. Throws if `initMqtt()` has not resolved.
 *
 * Callers that may run before bootstrap completes should await `initMqtt()`
 * directly; this accessor is for hot paths (the bridge, the projector, the
 * plugin host services) where bootstrap ordering already guarantees presence.
 */
export function getClient(): MqttClient {
  if (!_client) {
    throw new Error(
      "MQTT host singleton is not initialised. Call initMqtt() during server bootstrap before invoking publish/subscribe.",
    );
  }
  return _client;
}

/** Whether the singleton has been initialised. Useful for code that wants
 *  to soft-skip MQTT publishes during unit tests. */
export function isMqttInitialised(): boolean {
  return _client !== null;
}

export function getHostSingletonDiagnostics(): { brokerUrl: string | null; connected: boolean } {
  if (!_client) return { brokerUrl: null, connected: false };
  const opts = (_client as unknown as { options?: { href?: string; host?: string; port?: number; protocol?: string } }).options ?? {};
  let url: string | null = opts.href ?? null;
  if (!url && opts.protocol && opts.host) {
    const protocol = opts.protocol.endsWith(":") ? opts.protocol : `${opts.protocol}:`;
    url = `${protocol}//${opts.host}:${opts.port ?? "?"}`;
  }
  return { brokerUrl: url, connected: (_client as unknown as { connected?: boolean }).connected === true };
}

/**
 * Publish a message via the host singleton. Wraps the adapter's
 * `publishEvent` helper so callers don't need to import the package.
 */
export async function publish(
  topic: string,
  payload: unknown,
  opts: PublishEventOptions = {},
): Promise<void> {
  return publishEvent(getClient(), topic, payload, opts);
}

/**
 * Publish a retained message (Agent Card etc.) via the host singleton.
 */
export async function publishRetainedMessage(
  topic: string,
  payload: unknown,
  props?: { userProperties?: Record<string, string>; contentType?: string },
): Promise<void> {
  return publishRetained(getClient(), topic, payload, props);
}

/**
 * Subscribe to a topic pattern via the host singleton. Returns an opaque
 * handle whose `unsubscribe()` removes the message listener and issues an
 * MQTT UNSUBSCRIBE on the broker.
 */
export async function subscribe(
  topicPattern: string,
  handler: SubscribeHandler,
): Promise<MqttSubscriptionHandle> {
  const unsubscribe = await subscribeRetained(getClient(), topicPattern, handler);
  return { topicPattern, unsubscribe };
}

/**
 * Graceful shutdown — called from the SIGINT/SIGTERM handler in
 * `server/src/index.ts`. Closes the broker connection cleanly so a
 * Last-Will payload does NOT fire (we exited intentionally).
 */
export async function shutdownMqtt(): Promise<void> {
  if (!_client) return;
  _shuttingDown = true;
  const client = _client;
  _client = null;
  _initPromise = null;
  try {
    await client.endAsync(false);
    logger.info("MQTT host singleton shut down cleanly");
  } catch (err) {
    logger.warn({ err }, "MQTT host singleton shutdown error");
  }
}

/** **Test-only.** Reset module state so each test can re-init the singleton. */
export function _resetForTesting(): void {
  _client = null;
  _initPromise = null;
  _shuttingDown = false;
}
