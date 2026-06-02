/**
 * Heartbeat MQTT bridge — Phase 1.8 (Heartbeat externalization).
 *
 * The host's existing 30s heartbeat tick (`server/src/services/heartbeat.ts`,
 * driven from `server/src/index.ts:732-797`) is the authoritative organism
 * pulse. This bridge takes the result of each tick and:
 *
 *  1. Publishes a per-company snapshot to `paperclip/v1/heartbeat/{companyId}`
 *     (QoS 0, retain false). Late subscribers wait < 30s for the next tick.
 *  2. Receives optional per-agent ACK messages on
 *     `paperclip/v1/heartbeat-ack/{companyId}/{agentId}` and writes them back
 *     to `agents.lastHeartbeatAt` so the existing poll-based fallback stays
 *     informed.
 *
 * The bridge does NOT fork heartbeat.ts; it is purely additive. If MQTT is
 * unreachable, publishes soft-skip via `isMqttInitialised()`.
 *
 * In-memory tick counter — NOT stable across restart. We reset to 0 on each
 * server boot; subscribers should rely on `timestamp`, not `tickId`, for
 * ordering. Persisting the counter would require another column on
 * `companies` and the value carries no semantics beyond "did the tick run".
 */

import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  heartbeatTopic,
  heartbeatAckTopic,
  heartbeatAckWildcard,
  hostEventTopic,
} from "@paperclipai/adapter-a2a-mqtt/server";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import {
  isMqttInitialised,
  publish,
  subscribe,
  type MqttSubscriptionHandle,
} from "./client.js";

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

export type HeartbeatDegradedMode = "green" | "yellow" | "red";

export interface HeartbeatPayloadV1 {
  tickId: number;
  timestamp: string;
  dbHealthy: boolean;
  brokerHealthy: boolean;
  activeAgentCount: number;
  openEscalations: number;
  silentRunsDetected: number;
  recoveredRuns: number;
  degradedMode: HeartbeatDegradedMode;
  lastIdmPhaseAdvance: string | null;
  lastTacticalPulseByCircle: Record<string, string>;
  lastGovernancePulseByCircle: Record<string, string>;
}

/**
 * Counts threaded into the bridge from the post-tick hook in
 * `server/src/index.ts`. All fields are optional — callers populate whatever
 * the recovery functions return and the bridge fills in DB-aggregated values
 * for the rest.
 */
export interface HeartbeatTickResult {
  recoveredRuns?: number;
  silentRunsDetected?: number;
  reapedOrphans?: number;
  brokerHealthy?: boolean;
  dbHealthy?: boolean;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _db: Db | null = null;
let _tickId = 0;
let _ackSubscription: MqttSubscriptionHandle | null = null;

/** Reset module state. Test-only helper. */
export function _resetForTesting(): void {
  _db = null;
  _tickId = 0;
  _ackSubscription = null;
}

// ---------------------------------------------------------------------------
// Init / shutdown
// ---------------------------------------------------------------------------

/**
 * Bootstrap the heartbeat bridge. Subscribes the host singleton to
 * `paperclip/v1/heartbeat-ack/+/+` for inbound ACKs. Idempotent — safe to
 * call from server bootstrap regardless of MQTT init order.
 */
export async function initHeartbeatBridge(db: Db): Promise<void> {
  _db = db;
  if (!isMqttInitialised()) {
    logger.debug("heartbeat-bridge: MQTT not initialised, skipping ACK subscription");
    return;
  }
  if (_ackSubscription) {
    return; // idempotent
  }
  try {
    _ackSubscription = await subscribe(heartbeatAckWildcard(), async (msg) => {
      try {
        await handleHeartbeatAckFromAgent(msg.topic, msg.payload);
      } catch (err) {
        logger.warn({ err, topic: msg.topic }, "heartbeat-bridge: ACK handler failed");
      }
    });
    logger.info({ topic: heartbeatAckWildcard() }, "heartbeat-bridge: subscribed to ACK channel");
  } catch (err) {
    logger.warn({ err }, "heartbeat-bridge: failed to subscribe to heartbeat-ack");
  }
}

export async function shutdownHeartbeatBridge(): Promise<void> {
  if (_ackSubscription) {
    try {
      await _ackSubscription.unsubscribe();
    } catch (err) {
      logger.debug({ err }, "heartbeat-bridge: ack unsubscribe failed");
    }
    _ackSubscription = null;
  }
  _db = null;
  _tickId = 0;
}

// ---------------------------------------------------------------------------
// ACK handler
// ---------------------------------------------------------------------------

/**
 * Parse a heartbeat ACK message and update `agents.lastHeartbeatAt`.
 * Topic shape: `paperclip/v1/heartbeat-ack/{companyId}/{agentId}`.
 *
 * Payload (best-effort): `{tickId, queueDepth, focusedOnIssueId?}`. We only
 * use the topic-derived agentId to attribute the heartbeat write.
 */
export async function handleHeartbeatAckFromAgent(
  topic: string,
  _payload: Buffer | string | Record<string, unknown>,
): Promise<void> {
  if (!_db) return;
  const segments = topic.split("/");
  // paperclip / v1 / heartbeat-ack / {companyId} / {agentId}
  if (segments.length !== 5) return;
  const companyId = segments[3]!;
  const agentId = segments[4]!;
  if (!companyId || !agentId) return;
  try {
    await _db.execute(sql`
      UPDATE public.agents
      SET last_heartbeat_at = NOW()
      WHERE id = ${agentId}::uuid AND company_id = ${companyId}::uuid
    `);
  } catch (err) {
    logger.debug({ err, agentId }, "heartbeat-bridge: failed to update lastHeartbeatAt from ACK");
  }
}

// ---------------------------------------------------------------------------
// Degraded-mode derivation
// ---------------------------------------------------------------------------

function deriveDegradedMode(args: {
  dbHealthy: boolean;
  brokerHealthy: boolean;
  silentRunsDetected: number;
  recoveredRuns: number;
  openEscalations: number;
}): HeartbeatDegradedMode {
  if (!args.brokerHealthy || !args.dbHealthy) return "red";
  // Escalation rate spike: > 5 open escalations is a strong signal.
  if (args.openEscalations > 5) return "red";
  if (args.recoveredRuns > 0 || args.silentRunsDetected > 0) return "yellow";
  return "green";
}

// ---------------------------------------------------------------------------
// Per-company aggregation
// ---------------------------------------------------------------------------

interface CompanyAggregates {
  companyId: string;
  activeAgentCount: number;
  openEscalations: number;
  lastIdmPhaseAdvance: string | null;
  lastTacticalPulseByCircle: Record<string, string>;
  lastGovernancePulseByCircle: Record<string, string>;
}

async function aggregateCompanies(db: Db): Promise<CompanyAggregates[]> {
  // Active agents per company
  let agentRows: Array<{ companyId: string; activeAgentCount: number }> = [];
  try {
    const rows = await db.execute<{ companyId: string; activeAgentCount: number }>(sql`
      SELECT company_id::text AS "companyId", COUNT(*)::int AS "activeAgentCount"
      FROM public.agents
      WHERE status NOT IN ('terminated', 'paused', 'pending_approval')
      GROUP BY company_id
    `);
    agentRows = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: typeof agentRows }).rows ?? [];
  } catch (err) {
    logger.debug({ err }, "heartbeat-bridge: active-agent aggregate failed");
  }

  // Open harness-liveness escalations: best-effort via activity log lookup.
  let escalationRows: Array<{ companyId: string; openEscalations: number }> = [];
  try {
    const rows = await db.execute<{ companyId: string; openEscalations: number }>(sql`
      SELECT company_id::text AS "companyId", COUNT(*)::int AS "openEscalations"
      FROM public.issues
      WHERE origin_kind = 'harness_liveness_escalation' AND status NOT IN ('done', 'closed', 'archived')
      GROUP BY company_id
    `);
    escalationRows = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: typeof escalationRows }).rows ?? [];
  } catch (err) {
    logger.debug({ err }, "heartbeat-bridge: escalation aggregate failed");
  }

  // Tactical-pulse and governance-pulse per circle, best-effort against the
  // holacracy plugin schema. Empty maps when the schema isn't present.
  const tacticalByCompany = new Map<string, Record<string, string>>();
  const governanceByCompany = new Map<string, Record<string, string>>();
  try {
    const rows = await db.execute<{
      companyId: string;
      circleId: string;
      cadence: string;
      recordedAt: string;
    }>(sql`
      SELECT company_id::text AS "companyId", circle_id::text AS "circleId",
             cadence AS "cadence", MAX(recorded_at)::text AS "recordedAt"
      FROM plugin_holacracy_c5049b5dfe.tactical_records
      GROUP BY company_id, circle_id, cadence
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<{ companyId: string; circleId: string; cadence: string; recordedAt: string }> }).rows ?? [];
    for (const row of list) {
      const bucket = row.cadence === "governance" ? governanceByCompany : tacticalByCompany;
      const entry = bucket.get(row.companyId) ?? {};
      entry[row.circleId] = row.recordedAt;
      bucket.set(row.companyId, entry);
    }
  } catch {
    // schema not installed — leave empty
  }

  // IDM last phase advance per company. Approximated by the most recent
  // `updated_at` on idm_approvals; the per-row phase_started_at column does
  // not exist in migration 008.
  const idmLastByCompany = new Map<string, string>();
  try {
    const rows = await db.execute<{ companyId: string; lastAdvance: string }>(sql`
      SELECT company_id::text AS "companyId",
             MAX(updated_at)::text AS "lastAdvance"
      FROM plugin_holacracy_c5049b5dfe.idm_approvals
      GROUP BY company_id
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<{ companyId: string; lastAdvance: string }> }).rows ?? [];
    for (const row of list) {
      idmLastByCompany.set(row.companyId, row.lastAdvance);
    }
  } catch {
    // schema not installed
  }

  // Build the union of all known companies from any of the aggregate rows.
  const companyIds = new Set<string>();
  for (const row of agentRows) companyIds.add(row.companyId);
  for (const row of escalationRows) companyIds.add(row.companyId);
  for (const id of tacticalByCompany.keys()) companyIds.add(id);
  for (const id of governanceByCompany.keys()) companyIds.add(id);
  for (const id of idmLastByCompany.keys()) companyIds.add(id);

  // Also include companies with zero agents so they still emit a tick.
  try {
    const rows = await db.execute<{ companyId: string }>(sql`
      SELECT id::text AS "companyId" FROM public.companies WHERE status != 'archived'
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<{ companyId: string }> }).rows ?? [];
    for (const row of list) companyIds.add(row.companyId);
  } catch (err) {
    logger.debug({ err }, "heartbeat-bridge: company enumeration failed");
  }

  const agentMap = new Map(agentRows.map((r) => [r.companyId, r.activeAgentCount]));
  const escMap = new Map(escalationRows.map((r) => [r.companyId, r.openEscalations]));

  return [...companyIds].map((companyId) => ({
    companyId,
    activeAgentCount: agentMap.get(companyId) ?? 0,
    openEscalations: escMap.get(companyId) ?? 0,
    lastIdmPhaseAdvance: idmLastByCompany.get(companyId) ?? null,
    lastTacticalPulseByCircle: tacticalByCompany.get(companyId) ?? {},
    lastGovernancePulseByCircle: governanceByCompany.get(companyId) ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Public — post-tick publish
// ---------------------------------------------------------------------------

/**
 * Publish a heartbeat snapshot per company. Called from the server bootstrap
 * tick loop right after recovery functions have run. Never blocks or throws —
 * broker outages produce a warn log and return.
 */
export async function publishHeartbeatToMqtt(
  tickResult: HeartbeatTickResult,
  db: Db,
): Promise<void> {
  if (!isMqttInitialised()) return;
  if (!_db) _db = db;
  const now = new Date();
  _tickId += 1;
  const tickId = _tickId;

  let companies: CompanyAggregates[] = [];
  try {
    companies = await aggregateCompanies(db);
  } catch (err) {
    logger.warn({ err }, "heartbeat-bridge: aggregation failed, publishing empty heartbeat");
  }

  const brokerHealthy = tickResult.brokerHealthy ?? true;
  const dbHealthy = tickResult.dbHealthy ?? true;
  const recoveredRuns = tickResult.recoveredRuns ?? 0;
  const silentRunsDetected = tickResult.silentRunsDetected ?? 0;

  for (const aggregate of companies) {
    const payload: HeartbeatPayloadV1 = {
      tickId,
      timestamp: now.toISOString(),
      dbHealthy,
      brokerHealthy,
      activeAgentCount: aggregate.activeAgentCount,
      openEscalations: aggregate.openEscalations,
      silentRunsDetected,
      recoveredRuns,
      degradedMode: deriveDegradedMode({
        dbHealthy,
        brokerHealthy,
        silentRunsDetected,
        recoveredRuns,
        openEscalations: aggregate.openEscalations,
      }),
      lastIdmPhaseAdvance: aggregate.lastIdmPhaseAdvance,
      lastTacticalPulseByCircle: aggregate.lastTacticalPulseByCircle,
      lastGovernancePulseByCircle: aggregate.lastGovernancePulseByCircle,
    };
    try {
      await publish(heartbeatTopic(aggregate.companyId), payload, {
        qos: 0,
        retain: false,
      });
    } catch (err) {
      logger.debug({ err, companyId: aggregate.companyId }, "heartbeat-bridge: publish failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Event re-publish helpers (used by mqtt/bridge.ts)
// ---------------------------------------------------------------------------

/**
 * Bridge `issue.harness_liveness_escalation` events to the host event topic
 * (`paperclip/v1/event/{companyId}/_/liveness-escalation`). The bridge in
 * `mqtt/bridge.ts` calls this when it sees a matching event type.
 */
export async function publishLivenessEscalationToMqtt(event: PluginEvent): Promise<void> {
  if (!isMqttInitialised()) return;
  const companyId = event.companyId;
  if (!companyId) return;
  try {
    await publish(
      hostEventTopic(companyId, "_", "liveness-escalation"),
      event,
      {
        qos: 1,
        retain: false,
        userProperties: {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          publishedBy: "paperclip",
        },
      },
    );
  } catch (err) {
    logger.debug({ err, eventId: event.eventId }, "heartbeat-bridge: liveness-escalation publish failed");
  }
}

/**
 * Bridge `heartbeat.watchdog_decision` events to
 * `paperclip/v1/event/{companyId}/_/watchdog-decision`.
 */
export async function publishWatchdogDecisionToMqtt(event: PluginEvent): Promise<void> {
  if (!isMqttInitialised()) return;
  const companyId = event.companyId;
  if (!companyId) return;
  try {
    await publish(
      hostEventTopic(companyId, "_", "watchdog-decision"),
      event,
      {
        qos: 1,
        retain: false,
        userProperties: {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          publishedBy: "paperclip",
        },
      },
    );
  } catch (err) {
    logger.debug({ err, eventId: event.eventId }, "heartbeat-bridge: watchdog-decision publish failed");
  }
}
