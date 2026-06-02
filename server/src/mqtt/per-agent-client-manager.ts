/**
 * Per-agent MQTT client manager — Phase 1.11 "own ears and voice".
 *
 * Each managed agent gets its OWN broker connection: own client_id
 * (`{companyId}/{homeCircleId}/{agentId}`), own credentials derived via
 * `computeAgentMqttPassword`, own LWT for sub-second broker-observed
 * presence, and its own subscription set for the six Phase 1.10 addressing
 * dimensions. The host singleton in `client.ts` continues to handle system
 * topics (heartbeat, DNA, projector bootstrap publishes, bridge.ts event
 * republishes) and serves as a fallback during boot and after partial
 * outages.
 *
 * Cutover is staged via `PAPERCLIP_PER_AGENT_MQTT={off|hybrid|full}`:
 *   - `off`   — Phase 1.10 behaviour exactly; manager is inert.
 *   - `hybrid`— Default. Manager runs alongside the host bridge; the bridge
 *               short-circuits its inbound handler when `isReady(agentId)`.
 *               `reconcileSubscriptions` is called on both paths.
 *   - `full`  — Host bridge skips per-agent subscriptions; only the manager
 *               binds to per-agent topics. System topics stay on the host.
 *
 * Idempotency on duplicate delivery (broker delivers to both the host
 * singleton AND the per-agent client during hybrid mode) is preserved by
 * the `a2a_pending_replies.task_id` unique constraint — the shared inbound
 * handler in `inbound-handler.ts` finds the existing row and bails out.
 *
 * Follow-up: the `publishAs` SDK surface is exposed but no worker handler
 * has been migrated yet. Tactical-pulse cross-link emit is the first
 * candidate.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys } from "@paperclipai/db";
import type { MqttClient } from "mqtt";
import {
  createA2AClient,
  discoveryTopic,
  publishEvent,
  type PublishEventOptions,
} from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";
import { coerceRowsList } from "../util/db.js";
import { isMqttInitialised } from "./client.js";
import { computeAgentMqttPassword } from "./auth-backend.js";
import {
  computeDesiredFiltersForAgent,
  type AgentSlot,
} from "./subscription-compute.js";
import { handleA2AInbound } from "./inbound-handler.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface AgentMqttHandle {
  client: MqttClient;
  slot: AgentSlot;
  subscriptions: Set<string>;
  consecutiveFailures: number;
  lastError?: Error;
  connectedAt?: Date;
  isFallback: boolean;
  /**
   * Pending subscribe retries (filter → {attempt count, timer}). When a
   * broker SUBACK comes back with `qos >= 128` (ACL deny) or the
   * underlying client throws, we schedule a retry instead of silently
   * marking the filter "subscribed" — see `scheduleSubscribeRetry`.
   */
  retryTimers: Map<string, NodeJS.Timeout>;
  retryAttempts: Map<string, number>;
}

/** Subscribe-retry backoff schedule. After the last entry we give up. */
const SUBSCRIBE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

const _handles = new Map<string, AgentMqttHandle>();
const _pending = new Map<string, Promise<void>>();
let _db: Db | null = null;
let _shuttingDown = false;
let _ceilingWarned = false;

/** Failure count at which we flip the handle to fallback mode (the host
 *  bridge resumes responsibility for the agent until recovery). */
const FALLBACK_THRESHOLD = 10;
/** Connection-count above which a single warning fires — operators should
 *  bump ulimit or split horizontally past this. */
const CEILING_WARN_THRESHOLD = 500;

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

export function mode(): "off" | "hybrid" | "full" {
  const raw = process.env.PAPERCLIP_PER_AGENT_MQTT?.trim().toLowerCase();
  if (raw === "off" || raw === "full") return raw;
  return "hybrid";
}

function keepaliveFromEnv(): number {
  const raw = process.env.PAPERCLIP_MQTT_KEEPALIVE_SECONDS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 5 && n <= 600) return n;
  }
  return process.env.NODE_ENV === "production" ? 60 : 15;
}

/** Duplicates `auth-backend.ts`'s `mqttAuthSecret` precedence so the
 *  per-agent password derivation matches what EMQX will validate. The
 *  duplication is intentional to keep auth-backend's boot-time assertion
 *  colocated with its callers. */
function resolveMqttAuthSecret(): string | null {
  const dedicated = process.env.PAPERCLIP_MQTT_AUTH_SECRET?.trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === "production") return null;
  return (
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    null
  );
}

// ---------------------------------------------------------------------------
// DB readers
// ---------------------------------------------------------------------------

async function loadHomeSlot(db: Db, agentId: string): Promise<AgentSlot | null> {
  try {
    const rows = await db.execute<{ companyId: string; circleId: string }>(sql`
      SELECT a.company_id::text AS "companyId",
             c.id::text         AS "circleId"
      FROM public.agents a
      JOIN plugin_holacracy_c5049b5dfe.role_assignments ra ON ra.agent_id = a.id
      JOIN plugin_holacracy_c5049b5dfe.roles r              ON r.id = ra.role_id
      JOIN plugin_holacracy_c5049b5dfe.circles c            ON c.id = r.circle_id
      WHERE a.id = ${agentId}::uuid
        AND a.status NOT IN ('archived', 'terminated')
      ORDER BY ra.assigned_at DESC NULLS LAST
      LIMIT 1
    `);
    const list = coerceRowsList<{ companyId: string; circleId: string }>(rows);
    if (list[0]) {
      return {
        companyId: list[0].companyId,
        circleId: list[0].circleId,
        agentId,
      };
    }
  } catch {
    // Holacracy schema not installed — fall through to the synthetic-circle path.
  }
  try {
    const compRows = await db.execute<{ companyId: string }>(sql`
      SELECT company_id::text AS "companyId"
      FROM public.agents
      WHERE id = ${agentId}::uuid AND status NOT IN ('archived', 'terminated')
      LIMIT 1
    `);
    const compList = Array.isArray(compRows)
      ? compRows
      : (compRows as unknown as { rows: Array<{ companyId: string }> }).rows ?? [];
    if (!compList[0]) return null;
    return {
      companyId: compList[0].companyId,
      circleId: compList[0].companyId,
      agentId,
    };
  } catch (err) {
    logger.debug({ err, agentId }, "per-agent-client-manager: home slot lookup failed");
    return null;
  }
}

async function loadLatestKeyHash(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select({ keyHash: agentApiKeys.keyHash })
      .from(agentApiKeys)
      .where(
        and(
          eq(agentApiKeys.agentId, agentId),
          eq(agentApiKeys.companyId, companyId),
          isNull(agentApiKeys.revokedAt),
        ),
      )
      .orderBy(desc(agentApiKeys.createdAt))
      .limit(1);
    return rows[0]?.keyHash ?? null;
  } catch (err) {
    logger.debug({ err, agentId }, "per-agent-client-manager: key hash lookup failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inbound handler bound to a handle
// ---------------------------------------------------------------------------

async function handleInbound(
  handle: AgentMqttHandle,
  topic: string,
  payload: Buffer,
  packet: unknown,
): Promise<void> {
  if (!_db) return;
  const props =
    ((packet as { properties?: Record<string, unknown> } | undefined)
      ?.properties as Record<string, unknown> | undefined) ?? {};
  const responseTopic =
    typeof (props as { responseTopic?: string }).responseTopic === "string"
      ? ((props as { responseTopic?: string }).responseTopic ?? null)
      : null;
  const corrRaw = (props as { correlationData?: Buffer | Uint8Array }).correlationData;
  const correlationData = corrRaw
    ? Buffer.isBuffer(corrRaw)
      ? corrRaw
      : Buffer.from(corrRaw)
    : null;
  const contentType =
    typeof (props as { contentType?: string }).contentType === "string"
      ? ((props as { contentType?: string }).contentType ?? null)
      : null;
  const userProperties = normaliseUserProperties(
    (props as { userProperties?: unknown }).userProperties,
  );
  const retain = Boolean((packet as { retain?: boolean } | undefined)?.retain);

  await handleA2AInbound(
    { db: _db, actorId: "per-agent-client" },
    handle.slot,
    {
      topic,
      payload,
      userProperties,
      retain,
      contentType,
      responseTopic,
      correlationData,
    },
  );
}

function normaliseUserProperties(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
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
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value.length > 0) {
      const last = value[value.length - 1];
      if (typeof last === "string") out[key] = last;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

export async function ensureAgent(agentId: string): Promise<void> {
  if (mode() === "off") return;
  if (_shuttingDown) return;
  if (_handles.has(agentId)) return;
  const existing = _pending.get(agentId);
  if (existing) return existing;

  const task = (async () => {
    if (!_db) return;
    const slot = await loadHomeSlot(_db, agentId);
    if (!slot) {
      logger.debug({ agentId }, "per-agent-client-manager: no home slot, skipping connect");
      return;
    }
    const keyHash = await loadLatestKeyHash(_db, slot.companyId, agentId);
    if (!keyHash) {
      logger.debug({ agentId }, "per-agent-client-manager: no api key, skipping connect");
      return;
    }
    const secret = resolveMqttAuthSecret();
    if (!secret) {
      logger.warn(
        { agentId },
        "per-agent-client-manager: no MQTT auth secret available; cannot derive password",
      );
      return;
    }
    const username = `${slot.companyId}/${slot.circleId}/${slot.agentId}`;
    const password = computeAgentMqttPassword({
      keyHash,
      companyId: slot.companyId,
      agentId: slot.agentId,
      secret,
    });
    const brokerUrl =
      process.env.PAPERCLIP_MQTT_BROKER_URL?.trim() ?? "mqtt://localhost:1883";

    const willTopic = discoveryTopic(slot.companyId, slot.circleId, slot.agentId);
    const willUserProperties = {
      "a2a-status": "offline",
      "a2a-status-source": "lwt",
      publishedBy: "broker-lwt",
    };

    let client: MqttClient;
    try {
      client = await createA2AClient({
        brokerUrl,
        clientId: username,
        username,
        password,
        cleanStart: true,
        keepalive: keepaliveFromEnv(),
        willTopic,
        willPayload: "",
        willRetain: true,
        willQos: 1,
        willUserProperties,
      });
    } catch (err) {
      logger.warn(
        { err, agentId },
        "per-agent-client-manager: initial connect failed",
      );
      return;
    }

    const handle: AgentMqttHandle = {
      client,
      slot,
      subscriptions: new Set(),
      consecutiveFailures: 0,
      isFallback: false,
      connectedAt: new Date(),
      retryTimers: new Map(),
      retryAttempts: new Map(),
    };
    _handles.set(agentId, handle);

    client.on("connect", () => {
      handle.consecutiveFailures = 0;
      handle.isFallback = false;
      handle.connectedAt = new Date();
      logger.info(
        { agentId, clientId: username },
        "per-agent-client-manager: agent connected",
      );
      void reconcileSubscriptions(agentId);
    });
    client.on("error", (err) => {
      handle.lastError = err instanceof Error ? err : new Error(String(err));
      handle.consecutiveFailures += 1;
      if (
        handle.consecutiveFailures >= FALLBACK_THRESHOLD &&
        !handle.isFallback
      ) {
        handle.isFallback = true;
        logger.warn(
          { agentId, err: handle.lastError },
          "per-agent-client-manager: agent fallback mode (10 consecutive failures)",
        );
      }
    });
    client.on("close", () => {
      if (_shuttingDown) return;
      handle.consecutiveFailures += 1;
      if (
        handle.consecutiveFailures >= FALLBACK_THRESHOLD &&
        !handle.isFallback
      ) {
        handle.isFallback = true;
        logger.warn(
          { agentId },
          "per-agent-client-manager: agent fallback mode (close loop)",
        );
      }
    });
    client.on("message", (topic, payload, packet) => {
      void handleInbound(handle, topic, payload, packet);
    });

    if (_handles.size >= CEILING_WARN_THRESHOLD && !_ceilingWarned) {
      _ceilingWarned = true;
      logger.warn(
        { connections: _handles.size },
        "per-agent-client-manager: 500 simultaneous connections — investigate ulimit + horizontal split",
      );
    }
  })().finally(() => {
    _pending.delete(agentId);
  });
  _pending.set(agentId, task);
  return task;
}

export async function dropAgent(agentId: string): Promise<void> {
  const handle = _handles.get(agentId);
  if (!handle) return;
  _handles.delete(agentId);
  for (const timer of handle.retryTimers.values()) clearTimeout(timer);
  handle.retryTimers.clear();
  handle.retryAttempts.clear();
  try {
    const topic = discoveryTopic(
      handle.slot.companyId,
      handle.slot.circleId,
      handle.slot.agentId,
    );
    await handle.client.publishAsync(topic, Buffer.alloc(0), {
      qos: 1,
      retain: true,
      properties: {
        userProperties: {
          "a2a-status-source": "agent",
          publishedBy: "paperclip",
        },
      },
    });
  } catch (err) {
    logger.debug(
      { err, agentId },
      "per-agent-client-manager: own-client deregister publish failed",
    );
  }
  try {
    await handle.client.endAsync(false);
  } catch (err) {
    logger.debug(
      { err, agentId },
      "per-agent-client-manager: endAsync error",
    );
  }
}

// ---------------------------------------------------------------------------
// Subscription reconciliation
// ---------------------------------------------------------------------------

export async function reconcileSubscriptions(agentId: string): Promise<void> {
  if (mode() === "off") return;
  const handle = _handles.get(agentId);
  if (!handle) return;
  if (!_db) return;

  const desired = new Set(await computeDesiredFiltersForAgent(_db, agentId));

  for (const filter of desired) {
    if (handle.subscriptions.has(filter)) continue;
    // A retry timer is already scheduled — let it run instead of racing.
    if (handle.retryTimers.has(filter)) continue;
    await trySubscribe(handle, filter, /*isRetry*/ false);
  }
  for (const filter of [...handle.subscriptions]) {
    if (desired.has(filter)) continue;
    try {
      await handle.client.unsubscribeAsync(filter);
    } catch {
      // best-effort
    }
    handle.subscriptions.delete(filter);
  }
  // Filters that are no longer desired but still scheduled for retry
  // should also be abandoned.
  for (const [filter, timer] of handle.retryTimers) {
    if (!desired.has(filter)) {
      clearTimeout(timer);
      handle.retryTimers.delete(filter);
      handle.retryAttempts.delete(filter);
    }
  }
}

/**
 * Attempt a single subscribe. On success: add to handle.subscriptions and
 * clear any pending retry state. On broker-denied (SUBACK ≥ 128) or thrown
 * error: schedule a backoff retry (or give up after the schedule is
 * exhausted). Caller must verify the filter isn't already subscribed.
 */
async function trySubscribe(
  handle: AgentMqttHandle,
  filter: string,
  isRetry: boolean,
): Promise<void> {
  const agentId = handle.slot.agentId;
  const attempt = handle.retryAttempts.get(filter) ?? 0;
  try {
    const grants = await handle.client.subscribeAsync(filter, { qos: 1 });
    // mqtt.js resolves subscribeAsync even on broker-side ACL deny — the
    // SUBACK comes back with `qos >= 128` (MQTT5 reason code ≥ 128). Only
    // mark the filter subscribed when the broker actually granted it.
    const granted = Array.isArray(grants) ? grants : [];
    const denied = granted.some((g) => typeof g?.qos === "number" && g.qos >= 128);
    if (denied) {
      logger.warn(
        { agentId, filter, granted, attempt, isRetry },
        "per-agent-client-manager: subscribe denied by broker (SUBACK ≥ 128)",
      );
      scheduleSubscribeRetry(handle, filter);
      return;
    }
    handle.subscriptions.add(filter);
    handle.retryAttempts.delete(filter);
    const existingTimer = handle.retryTimers.get(filter);
    if (existingTimer) {
      clearTimeout(existingTimer);
      handle.retryTimers.delete(filter);
    }
    logger.info(
      { agentId, filter, granted, attempt, isRetry },
      isRetry
        ? "per-agent-client-manager: subscribe succeeded on retry"
        : "per-agent-client-manager: subscribed",
    );
  } catch (err) {
    handle.consecutiveFailures = (handle.consecutiveFailures ?? 0) + 1;
    logger.warn(
      {
        err,
        agentId,
        filter,
        attempt,
        isRetry,
        consecutiveFailures: handle.consecutiveFailures,
        reasonCode: (err as { code?: unknown })?.code ?? null,
      },
      "per-agent-client-manager: subscribe failed",
    );
    scheduleSubscribeRetry(handle, filter);
  }
}

function scheduleSubscribeRetry(handle: AgentMqttHandle, filter: string): void {
  const agentId = handle.slot.agentId;
  const attempt = handle.retryAttempts.get(filter) ?? 0;
  if (attempt >= SUBSCRIBE_RETRY_DELAYS_MS.length) {
    logger.warn(
      { agentId, filter, attempts: attempt },
      "per-agent-client-manager: subscribe retries exhausted — giving up; next reconcile will re-try",
    );
    handle.retryAttempts.delete(filter);
    handle.retryTimers.delete(filter);
    return;
  }
  const delay = SUBSCRIBE_RETRY_DELAYS_MS[attempt]!;
  handle.retryAttempts.set(filter, attempt + 1);
  const existing = handle.retryTimers.get(filter);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    handle.retryTimers.delete(filter);
    if (handle.subscriptions.has(filter)) {
      handle.retryAttempts.delete(filter);
      return;
    }
    void trySubscribe(handle, filter, /*isRetry*/ true);
  }, delay);
  // Don't keep the event loop alive just to retry a subscribe.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  handle.retryTimers.set(filter, timer);
  logger.info(
    { agentId, filter, attempt, nextDelayMs: delay },
    "per-agent-client-manager: subscribe retry scheduled",
  );
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function tryGetClient(agentId: string): MqttClient | null {
  const handle = _handles.get(agentId);
  if (!handle) return null;
  if (handle.isFallback) return null;
  if (!handle.client.connected) return null;
  return handle.client;
}

export function isReady(agentId: string): boolean {
  return tryGetClient(agentId) !== null;
}

export async function publishAs(
  agentId: string,
  topic: string,
  payload: unknown,
  opts?: PublishEventOptions,
): Promise<void> {
  const client = tryGetClient(agentId);
  if (!client) {
    throw new Error(
      `publishAs: no per-agent MQTT client for ${agentId}`,
    );
  }
  await publishEvent(client, topic, payload, opts ?? {});
}

export function getStats(): {
  connected: number;
  connecting: number;
  errored: number;
  fallback: number;
  total: number;
} {
  let connected = 0;
  let connecting = 0;
  let errored = 0;
  let fallback = 0;
  for (const h of _handles.values()) {
    if (h.isFallback) fallback += 1;
    if (h.client.connected) connected += 1;
    else if (h.client.reconnecting) connecting += 1;
    else errored += 1;
  }
  return { connected, connecting, errored, fallback, total: _handles.size };
}

// ---------------------------------------------------------------------------
// Bootstrap + shutdown
// ---------------------------------------------------------------------------

export async function initPerAgentClientManager(db: Db): Promise<void> {
  _db = db;
  if (mode() === "off") {
    logger.info(
      "per-agent-client-manager: PAPERCLIP_PER_AGENT_MQTT=off, skipping",
    );
    return;
  }
  if (!isMqttInitialised()) {
    logger.info(
      "per-agent-client-manager: host MQTT not initialised, skipping bootstrap",
    );
    return;
  }

  let agentIds: string[] = [];
  try {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id::text AS "id"
      FROM public.agents
      WHERE status NOT IN ('archived', 'terminated')
    `);
    const list = coerceRowsList<{ id: string }>(rows);
    agentIds = list.map((r) => r.id);
  } catch (err) {
    logger.warn({ err }, "per-agent-client-manager: bootstrap agent load failed");
    return;
  }
  logger.info(
    { count: agentIds.length, mode: mode() },
    "per-agent-client-manager: bootstrap",
  );

  const POOL = 16;
  const DEADLINE_MS = 30_000;
  const queue = [...agentIds];
  const inflight: Promise<unknown>[] = [];
  const deadline = Date.now() + DEADLINE_MS;
  let attempted = 0;
  while (queue.length > 0 && Date.now() < deadline) {
    while (inflight.length < POOL && queue.length > 0) {
      const aid = queue.shift()!;
      attempted += 1;
      const p = ensureAgent(aid).finally(() => {
        const idx = inflight.indexOf(p);
        if (idx >= 0) inflight.splice(idx, 1);
      });
      inflight.push(p);
    }
    if (inflight.length === 0) break;
    await Promise.race(inflight);
  }
  logger.info(
    {
      attempted,
      queued: queue.length,
      succeeded: _handles.size,
    },
    "per-agent-client-manager: bootstrap dispatch complete",
  );
}

export async function shutdownPerAgentClientManager(): Promise<void> {
  _shuttingDown = true;
  const agentIds = [..._handles.keys()];
  await Promise.all(agentIds.map((id) => dropAgent(id)));
  _handles.clear();
  _pending.clear();
  _db = null;
}

export function _resetForTesting(): void {
  _handles.clear();
  _pending.clear();
  _db = null;
  _shuttingDown = false;
  _ceilingWarned = false;
}
