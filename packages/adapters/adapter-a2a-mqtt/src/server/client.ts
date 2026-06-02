/**
 * Shared MQTT v5 client wrapper for the A2A-over-MQTT transport.
 *
 * Used by:
 *  - the host-side singleton (server/src/mqtt/client.ts) for projector +
 *    bridge + ACL backend probes
 *  - this adapter's execute()/test()/skills paths
 *  - external agent runtimes that want to speak the same transport
 *
 * Why a wrapper:
 *  - normalises mqtt.js's MQTT v5 property surface (User Properties,
 *    Response Topic, Correlation Data, Content Type)
 *  - supplies a request/reply primitive that matches A2A's Task pattern
 *  - keeps the API stable across mqtt.js point releases
 */

import { connectAsync, type MqttClient, type IClientOptions } from "mqtt";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Config + connection
// ---------------------------------------------------------------------------

export interface A2AClientConfig {
  /** e.g. "mqtt://localhost:1883" or "mqtts://emqx.example.com:8883" */
  brokerUrl: string;
  /** Client identifier. Host singleton: "paperclip-host". Agents: `${companyId}/${circleId}/${agentId}`. */
  clientId: string;
  username?: string;
  password?: string;
  /** Whether to start a clean MQTT v5 session (default true). */
  cleanStart?: boolean;
  /** Keep-alive interval in seconds (default 60). */
  keepalive?: number;
  /** Will message topic (published by broker if client disconnects ungracefully). */
  willTopic?: string;
  /** Will message payload. */
  willPayload?: string;
  /** Will retain flag (typically true so the offline status persists). */
  willRetain?: boolean;
  /** Will QoS (default 1). */
  willQos?: 0 | 1 | 2;
  /** Will message MQTT v5 User Properties. */
  willUserProperties?: Record<string, string>;
  /** Per-connection MQTT v5 User Properties (sent on CONNECT). */
  userProperties?: Record<string, string>;
  /** Override TLS reject-unauthorized (default true). */
  rejectUnauthorized?: boolean;
}

/**
 * Connect to an MQTT broker speaking protocol version 5.
 *
 * Resolves to a connected client. Throws on the first CONNACK rejection or
 * underlying network error.
 */
export async function createA2AClient(
  config: A2AClientConfig,
): Promise<MqttClient> {
  const opts: IClientOptions = {
    protocolVersion: 5,
    clientId: config.clientId,
    username: config.username,
    password: config.password,
    clean: config.cleanStart ?? true,
    keepalive: config.keepalive ?? 60,
    reconnectPeriod: 1000,
    connectTimeout: 30_000,
    rejectUnauthorized: config.rejectUnauthorized ?? true,
  };

  if (config.userProperties && Object.keys(config.userProperties).length > 0) {
    opts.properties = {
      ...(opts.properties ?? {}),
      userProperties: { ...config.userProperties },
    };
  }

  if (config.willTopic) {
    opts.will = {
      topic: config.willTopic,
      payload: Buffer.from(config.willPayload ?? "", "utf-8"),
      qos: config.willQos ?? 1,
      retain: config.willRetain ?? true,
      properties:
        config.willUserProperties &&
        Object.keys(config.willUserProperties).length > 0
          ? { userProperties: { ...config.willUserProperties } }
          : undefined,
    };
  }

  return connectAsync(config.brokerUrl, opts);
}

// ---------------------------------------------------------------------------
// Publish helpers
// ---------------------------------------------------------------------------

function encodePayload(payload: unknown): Buffer {
  if (payload == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === "string") return Buffer.from(payload, "utf-8");
  return Buffer.from(JSON.stringify(payload), "utf-8");
}

function defaultContentType(payload: unknown): string | undefined {
  if (payload == null) return undefined;
  if (Buffer.isBuffer(payload) || typeof payload === "string") return undefined;
  return "application/json";
}

export interface PublishEventOptions {
  qos?: 0 | 1 | 2;
  retain?: boolean;
  responseTopic?: string;
  correlationData?: Buffer;
  userProperties?: Record<string, string>;
  contentType?: string;
  messageExpiryInterval?: number;
}

/**
 * Publish a retained message with qos=1. Used for Agent Card publication on
 * the discovery topic and other "current state" projections.
 */
export async function publishRetained(
  client: MqttClient,
  topic: string,
  payload: unknown,
  props?: { userProperties?: Record<string, string>; contentType?: string },
): Promise<void> {
  return publishEvent(client, topic, payload, {
    qos: 1,
    retain: true,
    userProperties: props?.userProperties,
    contentType: props?.contentType,
  });
}

/**
 * Publish a non-retained event (or retained, if `retain: true` passed) with
 * full MQTT v5 property support.
 */
export async function publishEvent(
  client: MqttClient,
  topic: string,
  payload: unknown,
  opts: PublishEventOptions = {},
): Promise<void> {
  const properties: NonNullable<IClientOptions["properties"]> & {
    responseTopic?: string;
    correlationData?: Buffer;
    contentType?: string;
    messageExpiryInterval?: number;
    userProperties?: Record<string, string>;
  } = {};

  if (opts.responseTopic) properties.responseTopic = opts.responseTopic;
  if (opts.correlationData) properties.correlationData = opts.correlationData;
  if (opts.userProperties && Object.keys(opts.userProperties).length > 0) {
    properties.userProperties = { ...opts.userProperties };
  }
  const contentType = opts.contentType ?? defaultContentType(payload);
  if (contentType) properties.contentType = contentType;
  if (typeof opts.messageExpiryInterval === "number") {
    properties.messageExpiryInterval = opts.messageExpiryInterval;
  }

  await client.publishAsync(topic, encodePayload(payload), {
    qos: opts.qos ?? 1,
    retain: opts.retain ?? false,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
  });
}

// ---------------------------------------------------------------------------
// Request / reply
// ---------------------------------------------------------------------------

export interface PublishRequestAwaitReplyOptions {
  requestTopic: string;
  replyTopic: string;
  payload: unknown;
  /** Default 60_000 (60s). Reject on expiry. */
  timeoutMs?: number;
  userProperties?: Record<string, string>;
  qos?: 0 | 1 | 2;
  contentType?: string;
}

export interface AwaitReplyResult {
  payload: unknown;
  /** Decoded MQTT v5 User Properties on the reply message. */
  userProperties: Record<string, string>;
  /** Raw payload buffer for callers that need bytes. */
  raw: Buffer;
  contentType: string | null;
}

function tryParseJsonBuffer(buf: Buffer, contentType: string | null): unknown {
  if (contentType && contentType.toLowerCase().includes("json")) {
    try {
      return JSON.parse(buf.toString("utf-8"));
    } catch {
      return buf.toString("utf-8");
    }
  }
  // Best-effort: attempt JSON, fall back to string, fall back to raw.
  const text = buf.toString("utf-8");
  if (text.length === 0) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function normaliseUserProperties(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  // mqtt.js may surface user properties as either a flat object or an array
  // of {k,v} pairs depending on duplicate keys.
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (
        entry &&
        typeof entry === "object" &&
        "name" in entry &&
        "value" in entry &&
        typeof (entry as { name: unknown }).name === "string" &&
        typeof (entry as { value: unknown }).value === "string"
      ) {
        const e = entry as { name: string; value: string };
        out[e.name] = e.value;
      }
    }
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      // Duplicate keys collapse to the last value (caller can disambiguate
      // via subscribeRetained's raw access if needed).
      const last = value[value.length - 1];
      if (typeof last === "string") out[key] = last;
    }
  }
  return out;
}

/**
 * Publish a request and await a matching reply on `replyTopic`.
 *
 * Subscribes to `replyTopic`, generates fresh Correlation Data, publishes
 * with the MQTT v5 Response Topic + Correlation Data properties, awaits the
 * first incoming message on `replyTopic` whose Correlation Data matches,
 * then unsubscribes.
 *
 * Default timeout is 60_000ms. Throws on timeout. The subscription is
 * always cleaned up.
 */
export async function publishRequestAwaitReply(
  client: MqttClient,
  opts: PublishRequestAwaitReplyOptions,
): Promise<AwaitReplyResult> {
  const correlationData = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const timeoutMs = opts.timeoutMs ?? 60_000;

  await client.subscribeAsync(opts.replyTopic, { qos: 1 });

  let timeoutHandle: NodeJS.Timeout | null = null;
  let messageHandler:
    | ((topic: string, payload: Buffer, packet: unknown) => void)
    | null = null;

  const cleanup = async (): Promise<void> => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (messageHandler) {
      client.off("message", messageHandler);
      messageHandler = null;
    }
    try {
      await client.unsubscribeAsync(opts.replyTopic);
    } catch {
      // best-effort unsubscribe; if the connection is dead, nothing to do.
    }
  };

  try {
    const reply = await new Promise<AwaitReplyResult>((resolve, reject) => {
      messageHandler = (topic, payload, packet) => {
        if (topic !== opts.replyTopic) return;
        const packetProps =
          (packet as { properties?: Record<string, unknown> } | undefined)
            ?.properties ?? {};
        const incomingCorr = (
          packetProps as { correlationData?: Buffer | Uint8Array }
        ).correlationData;
        if (!incomingCorr) return;
        const incomingBuf = Buffer.isBuffer(incomingCorr)
          ? incomingCorr
          : Buffer.from(incomingCorr);
        if (!incomingBuf.equals(correlationData)) return;

        const contentType =
          typeof (packetProps as { contentType?: string }).contentType ===
          "string"
            ? ((packetProps as { contentType?: string }).contentType ?? null)
            : null;
        const userProperties = normaliseUserProperties(
          (packetProps as { userProperties?: unknown }).userProperties,
        );
        resolve({
          payload: tryParseJsonBuffer(payload, contentType),
          userProperties,
          raw: payload,
          contentType,
        });
      };

      client.on("message", messageHandler);

      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `publishRequestAwaitReply: timed out after ${timeoutMs}ms waiting for reply on ${opts.replyTopic}`,
          ),
        );
      }, timeoutMs);

      publishEvent(client, opts.requestTopic, opts.payload, {
        qos: opts.qos ?? 1,
        retain: false,
        responseTopic: opts.replyTopic,
        correlationData,
        userProperties: opts.userProperties,
        contentType: opts.contentType,
      }).catch((err) => reject(err));
    });

    return reply;
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// Subscribe (retained + live)
// ---------------------------------------------------------------------------

export interface SubscribeMessage {
  topic: string;
  payload: Buffer;
  /** Decoded MQTT v5 user properties on the incoming message. */
  userProperties: Record<string, string>;
  /** Whether this was delivered as a retained message. */
  retain: boolean;
  contentType: string | null;
  responseTopic: string | null;
  correlationData: Buffer | null;
}

export type SubscribeHandler = (
  msg: SubscribeMessage,
) => void | Promise<void>;

/**
 * Subscribe to a topic (filter) and invoke `handler` for each message, including
 * the retained messages flushed on subscribe.
 *
 * Returns an `unsubscribe` function that removes the message listener and
 * issues an MQTT UNSUBSCRIBE.
 */
export async function subscribeRetained(
  client: MqttClient,
  topicPattern: string,
  handler: SubscribeHandler,
): Promise<() => Promise<void>> {
  const onMessage = (
    topic: string,
    payload: Buffer,
    packet: unknown,
  ): void => {
    // We let mqtt.js do topic-filter matching by only forwarding messages on
    // topics this subscription covers. mqtt.js delivers all messages to all
    // listeners, so do a coarse filter on the literal subscription topic.
    const pkt = packet as
      | {
          retain?: boolean;
          properties?: Record<string, unknown>;
        }
      | undefined;
    const props = pkt?.properties ?? {};
    const userProperties = normaliseUserProperties(
      (props as { userProperties?: unknown }).userProperties,
    );
    const contentType =
      typeof (props as { contentType?: string }).contentType === "string"
        ? ((props as { contentType?: string }).contentType ?? null)
        : null;
    const responseTopic =
      typeof (props as { responseTopic?: string }).responseTopic === "string"
        ? ((props as { responseTopic?: string }).responseTopic ?? null)
        : null;
    const corrRaw = (
      props as { correlationData?: Buffer | Uint8Array | undefined }
    ).correlationData;
    const correlationData = corrRaw
      ? Buffer.isBuffer(corrRaw)
        ? corrRaw
        : Buffer.from(corrRaw)
      : null;

    if (!topicMatchesFilter(topicPattern, topic)) return;

    void handler({
      topic,
      payload,
      userProperties,
      retain: Boolean(pkt?.retain),
      contentType,
      responseTopic,
      correlationData,
    });
  };

  client.on("message", onMessage);
  await client.subscribeAsync(topicPattern, { qos: 1 });

  return async () => {
    client.off("message", onMessage);
    try {
      await client.unsubscribeAsync(topicPattern);
    } catch {
      // ignore — connection may already be closed
    }
  };
}

// ---------------------------------------------------------------------------
// MQTT topic filter matcher (supports `+` and `#`)
// ---------------------------------------------------------------------------

function topicMatchesFilter(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  for (let i = 0; i < filterParts.length; i++) {
    const f = filterParts[i];
    if (f === "#") {
      // multi-level wildcard; must be last segment by MQTT spec
      return true;
    }
    if (f === "+") {
      if (i >= topicParts.length) return false;
      continue;
    }
    if (f !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}
