/**
 * A2A agent runtime bridge.
 *
 * Closes the "are agents actually talking through MQTT?" gap from Phase 1.5.
 * Phase 1.5 built the transport (broker, projector, bridge, ACL) and Phase 2
 * wires Holacracy primitives to publish via the SDK. But in-process Paperclip
 * agents (Claude/Codex local adapters) consume work via `issues` rows, not by
 * subscribing to MQTT. So when an external A2A agent (or another Paperclip
 * agent via the `a2a_mqtt` adapter) publishes to
 *   `paperclip/v1/request/{companyId}/{circleId}/{agentId}`
 * nothing receives it today.
 *
 * This module bridges that gap on the **inbound** side:
 *  - On bootstrap, query every (companyId, circleId, agentId) tuple and
 *    subscribe to the per-agent request topic.
 *  - When a message arrives, parse the A2A Task payload, idempotency-check
 *    via `a2a_pending_replies.task_id`, and create an `issues` row for the
 *    target agent so the normal heartbeat/execution loop picks it up.
 *  - Stash the MQTT v5 Response Topic + Correlation Data + user properties
 *    on the sidecar so the **outbound** path can build a matching reply.
 *
 * And on the **outbound** side:
 *  - Subscribe to host event-bus `issue.updated` events.
 *  - When an issue with a pending A2A reply transitions to `done`/`cancelled`
 *    (or back to `in_progress` after a failure), publish a Task reply on the
 *    stored Response Topic with matching Correlation Data.
 *
 * Subscriptions are recomputed when `role_assignment.*` events fire so a
 * newly assigned agent picks up its inbox without a restart.
 */

import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { a2aPendingReplies } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  publishEvent,
  type SubscribeMessage,
} from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";
import { coerceRowsList } from "../util/db.js";
import {
  getClient,
  isMqttInitialised,
  subscribe,
  type MqttSubscriptionHandle,
} from "./client.js";
import {
  computeDesiredSubscriptions,
  type AgentSlot,
} from "./subscription-compute.js";
import { handleA2AInbound } from "./inbound-handler.js";
import * as perAgentClientManager from "./per-agent-client-manager.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Active subscriptions, keyed by `${agentId}|${filter}`. For shared
 * subscriptions the topic-filter alone isn't unique (multiple agents share
 * the same `$share/<group>/<topic>` filter), and for circle/role broadcasts
 * multiple agents in the same circle/role share the same filter as well.
 * Composite keying lets each agent maintain its own in-process handler so
 * the inbound dispatcher can resolve the right `(companyId, circleId,
 * agentId)` triple. This map is global to the host singleton because the
 * host owns one mqtt connection that fans out to all agent inboxes.
 */
const _subscriptionsByTopic: Map<string, MqttSubscriptionHandle> = new Map();

let _db: Db | null = null;
let _started = false;

// ---------------------------------------------------------------------------
// DB readers
// ---------------------------------------------------------------------------

interface AgentSlotRow extends Record<string, unknown> {
  agentId: string;
}

interface AgentSkillRow extends Record<string, unknown> {
  agentId: string;
}

async function loadAllAgentSlots(db: Db): Promise<AgentSlotRow[]> {
  try {
    const rows = await db.execute<AgentSlotRow>(sql`
      SELECT DISTINCT a.id::text AS "agentId"
      FROM public.agents a
      JOIN plugin_holacracy_c5049b5dfe.role_assignments ra ON ra.agent_id = a.id
      WHERE a.status NOT IN ('terminated', 'archived')
    `);
    return coerceRowsList<AgentSlotRow>(rows);
  } catch (err) {
    logger.debug(
      { err },
      "agent-runtime-bridge: holacracy schema unavailable, no slots to subscribe",
    );
    return [];
  }
}

async function loadAllAgentSkills(db: Db): Promise<AgentSkillRow[]> {
  try {
    const rows = await db.execute<AgentSkillRow>(sql`
      SELECT id::text AS "agentId"
      FROM public.agents
      WHERE status != 'archived'
    `);
    return coerceRowsList<AgentSkillRow>(rows);
  } catch (err) {
    logger.debug({ err }, "agent-runtime-bridge: bulk agent load failed");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Inbound: A2A request → issues row (delegated to shared inbound-handler)
// ---------------------------------------------------------------------------

async function handleInboundRequest(
  slot: AgentSlot,
  msg: SubscribeMessage,
): Promise<void> {
  if (!_db) {
    logger.warn({ slot }, "agent-runtime-bridge: db not wired, dropping request");
    return;
  }
  // Phase 1.11 short-circuit: when the per-agent client is ready, it owns
  // the inbound path. The host singleton's duplicate delivery becomes a
  // no-op here. Correctness is also enforced by `a2a_pending_replies.task_id`
  // — the short-circuit is purely an optimisation.
  if (
    perAgentClientManager.mode() !== "off" &&
    perAgentClientManager.isReady(slot.agentId)
  ) {
    logger.debug(
      { slot, topic: msg.topic },
      "agent-runtime-bridge: short-circuit (per-agent ready)",
    );
    return;
  }
  await handleA2AInbound({ db: _db, actorId: "a2a-runtime-bridge" }, slot, msg);
}

// ---------------------------------------------------------------------------
// Subscription wiring (Phase 1.10 — multi-dimensional)
// ---------------------------------------------------------------------------

/**
 * Each Paperclip-managed agent listens on six topic dimensions:
 *
 *   1. Personal direct    paperclip/v1/request/{c}/{cir}/{a}
 *   2. Circle broadcast   paperclip/v1/event/{c}/{cir}/+
 *   3. Role pool          $share/paperclip-role/paperclip/v1/role/{c}/{cir}/{role}
 *   4. Role broadcast     paperclip/v1/role/{c}/{cir}/{role}/broadcast
 *   5. Skill pool         $share/paperclip-skill-{slug}/paperclip/v1/skill/{c}/{slug}
 *   6. Skill broadcast    paperclip/v1/skill/{c}/{slug}/broadcast
 *
 * The host singleton owns one MQTT connection; for each dimension we register
 * an in-process handler scoped to the agent so the inbound dispatcher knows
 * which `(companyId, circleId, agentId)` triple should receive the resulting
 * `issues` row. Subscriptions are keyed by `{agentId}|{filter}` so two agents
 * in the same circle can each have their own circle-broadcast handler.
 */
type DimensionKey = string; // `${agentId}|${filter}`

function makeKey(agentId: string, filter: string): DimensionKey {
  return `${agentId}|${filter}`;
}

async function ensureSubscribedDimension(
  agentId: string,
  filter: string,
  slot: AgentSlot,
): Promise<void> {
  if (!isMqttInitialised()) return;
  const key = makeKey(agentId, filter);
  if (_subscriptionsByTopic.has(key)) return;
  try {
    const handle = await subscribe(filter, (msg) =>
      handleInboundRequest(slot, msg),
    );
    _subscriptionsByTopic.set(key, handle);
    logger.debug({ filter, agentId }, "agent-runtime-bridge: subscribed");
  } catch (err) {
    logger.warn(
      { err, filter, agentId },
      "agent-runtime-bridge: subscribe failed",
    );
  }
}

async function ensureUnsubscribedKey(key: DimensionKey): Promise<void> {
  const handle = _subscriptionsByTopic.get(key);
  if (!handle) return;
  _subscriptionsByTopic.delete(key);
  try {
    await handle.unsubscribe();
  } catch (err) {
    logger.debug({ err, key }, "agent-runtime-bridge: unsubscribe failed");
  }
}

/**
 * Recompute the subscription set for one agent across all six dimensions.
 * Called from `role_assignment.*` / `agent.updated` event handlers.
 *
 * Phase 1.11 mode behaviour:
 *   - `off`     — host bridge keeps full ownership (legacy Phase 1.10 path).
 *   - `hybrid`  — host bridge still subscribes; manager subscribes too. The
 *                 host bridge's inbound handler short-circuits when the
 *                 per-agent client is ready.
 *   - `full`    — host bridge tears down its per-agent subscriptions; only
 *                 the manager binds to per-agent topics.
 */
async function reconcileAgentSubscriptions(agentId: string): Promise<void> {
  if (!_db) return;
  const m = perAgentClientManager.mode();

  if (m === "full") {
    // Host bridge no longer manages per-agent subscriptions; release any
    // legacy bindings and let the manager own the topics.
    const prefix = `${agentId}|`;
    for (const key of [..._subscriptionsByTopic.keys()]) {
      if (!key.startsWith(prefix)) continue;
      await ensureUnsubscribedKey(key);
    }
    await perAgentClientManager.reconcileSubscriptions(agentId);
    return;
  }

  const desired = await computeDesiredSubscriptions(_db, agentId);
  const desiredKeys = new Set<DimensionKey>();
  for (const entry of desired) {
    desiredKeys.add(makeKey(agentId, entry.filter));
    await ensureSubscribedDimension(agentId, entry.filter, entry.slot);
  }
  const prefix = `${agentId}|`;
  for (const key of [..._subscriptionsByTopic.keys()]) {
    if (!key.startsWith(prefix)) continue;
    if (!desiredKeys.has(key)) {
      await ensureUnsubscribedKey(key);
    }
  }

  if (m === "hybrid") {
    try {
      await perAgentClientManager.reconcileSubscriptions(agentId);
    } catch (err) {
      logger.debug(
        { err, agentId },
        "agent-runtime-bridge: per-agent reconcile failed",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound: issue.updated → A2A Task reply
// ---------------------------------------------------------------------------

interface PendingReplyRow {
  issueId: string;
  taskId: string;
  responseTopic: string;
  correlationData: Buffer | null;
  userProperties: Record<string, string>;
}

async function loadPendingReplyForIssue(
  db: Db,
  issueId: string,
): Promise<PendingReplyRow | null> {
  const rows = await db
    .select({
      issueId: a2aPendingReplies.issueId,
      taskId: a2aPendingReplies.taskId,
      responseTopic: a2aPendingReplies.responseTopic,
      correlationData: a2aPendingReplies.correlationData,
      userProperties: a2aPendingReplies.userProperties,
    })
    .from(a2aPendingReplies)
    .where(eq(a2aPendingReplies.issueId, issueId))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    issueId: row.issueId,
    taskId: row.taskId,
    responseTopic: row.responseTopic,
    correlationData:
      row.correlationData === null || row.correlationData === undefined
        ? null
        : Buffer.isBuffer(row.correlationData)
          ? row.correlationData
          : Buffer.from(row.correlationData as unknown as Uint8Array),
    userProperties: (row.userProperties ?? {}) as Record<string, string>,
  };
}

interface IssueRow extends Record<string, unknown> {
  id: string;
  status: string;
  originKind: string | null;
  a2aContextId: string | null;
  completionNote: string | null;
  failureReason: string | null;
}

async function loadIssueRow(db: Db, issueId: string): Promise<IssueRow | null> {
  // The `issues` table doesn't have explicit `completionNote` / `failureReason`
  // columns today — use any populated description or status text as a
  // best-effort body. Subscribers care about the state transition, not the
  // exact prose. Phase 1.13 also pulls `origin_kind` + `a2a_context_id` so
  // the reply hook can decide whether the issue is A2A-originated and echo
  // the conversation thread id on outbound replies.
  const rows = await db.execute<IssueRow>(sql`
    SELECT
      id::text AS "id",
      status   AS "status",
      origin_kind AS "originKind",
      a2a_context_id AS "a2aContextId",
      NULL::text AS "completionNote",
      NULL::text AS "failureReason"
    FROM public.issues
    WHERE id = ${issueId}::uuid
    LIMIT 1
  `);
  const list = coerceRowsList<IssueRow>(rows);
  return list[0] ?? null;
}

async function deletePendingReply(db: Db, issueId: string): Promise<void> {
  try {
    await db.delete(a2aPendingReplies).where(eq(a2aPendingReplies.issueId, issueId));
  } catch (err) {
    logger.debug({ err, issueId }, "agent-runtime-bridge: delete pending reply failed");
  }
}

async function publishA2AReply(
  pending: PendingReplyRow,
  issue: IssueRow,
): Promise<void> {
  const terminal = issue.status === "done" || issue.status === "cancelled" ? "completed"
    : issue.status === "blocked" ? "failed"
    : null;
  if (!terminal) return;

  // Phase 1.13 — multi-turn threading: echo the issue's `a2a_context_id` (set
  // by the inbound handler) on the outbound reply so the originator can group
  // the response into the same conversation thread.
  const contextId = issue.a2aContextId ?? undefined;

  const payload =
    terminal === "completed"
      ? {
          id: pending.taskId,
          ...(contextId ? { contextId } : {}),
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [
            {
              messageId: randomUUID(),
              parts: [{ text: issue.completionNote ?? "Done" }],
            },
          ],
        }
      : {
          id: pending.taskId,
          ...(contextId ? { contextId } : {}),
          status: { state: "TASK_STATE_FAILED" },
          message: {
            parts: [{ text: issue.failureReason ?? "Failed" }],
          },
        };

  try {
    await publishEvent(getClient(), pending.responseTopic, payload, {
      qos: 1,
      retain: false,
      correlationData: pending.correlationData ?? undefined,
      userProperties: {
        ...pending.userProperties,
        "a2a-status-source": "agent",
        // E5 — EMQX A2A spec: `a2a-task-context-id` for multi-turn; keep
        // legacy `a2a-context-id` alongside for backward-compat.
        ...(contextId ? { "a2a-task-context-id": contextId, "a2a-context-id": contextId } : {}),
      },
      contentType: "application/json",
    });
    logger.info(
      {
        taskId: pending.taskId,
        issueId: pending.issueId,
        terminal,
        responseTopic: pending.responseTopic,
      },
      "agent-runtime-bridge: A2A reply published",
    );
  } catch (err) {
    logger.warn(
      { err, taskId: pending.taskId, issueId: pending.issueId },
      "agent-runtime-bridge: failed to publish A2A reply",
    );
    throw err;
  }
}

/**
 * Phase 1.13 — resolve the (companyId, circleId, agentId) tuple for an issue
 * that originated from an A2A request when the in-process event payload did
 * not carry a `circleId`. The lookup walks
 * `issues.assignee_agent_id → holacracy.role_assignments → roles → circle_id`
 * so the bridge can still publish a per-agent event topic notification for
 * downstream subscribers. Returns `null` if the issue is not A2A-originated
 * or has no assignee in a known circle. Best-effort — any DB failure returns
 * `null` quietly so the caller falls back to dropping the publish.
 */
export async function resolveA2AOriginIssueTopicTuple(
  issueId: string,
): Promise<{ companyId: string; circleId: string; agentId: string } | null> {
  if (!_db) return null;
  try {
    const rows = await _db.execute<{
      companyId: string | null;
      circleId: string | null;
      agentId: string | null;
      originKind: string | null;
    }>(sql`
      SELECT
        i.company_id::text         AS "companyId",
        r.circle_id::text          AS "circleId",
        i.assignee_agent_id::text  AS "agentId",
        i.origin_kind              AS "originKind"
      FROM public.issues i
      LEFT JOIN plugin_holacracy_c5049b5dfe.role_assignments ra
        ON ra.agent_id = i.assignee_agent_id
      LEFT JOIN plugin_holacracy_c5049b5dfe.roles r
        ON r.id = ra.role_id
      WHERE i.id = ${issueId}::uuid
      ORDER BY r.circle_id NULLS LAST
      LIMIT 1
    `);
    const list = coerceRowsList<Record<string, string | null>>(rows);
    const row = list[0];
    if (!row) return null;
    if (row.originKind !== "a2a:request") return null;
    if (!row.companyId || !row.circleId || !row.agentId) return null;
    return { companyId: row.companyId, circleId: row.circleId, agentId: row.agentId };
  } catch (err) {
    logger.debug({ err, issueId }, "agent-runtime-bridge: A2A topic-tuple resolve failed");
    return null;
  }
}

/**
 * Inspect a domain event; if it touches an A2A-pending issue and the new
 * status is terminal, publish a Task reply and clear the sidecar row.
 */
export async function handleIssueLifecycleEventForA2A(event: PluginEvent): Promise<void> {
  if (!_db || !isMqttInitialised()) return;
  if (event.eventType !== "issue.updated") return;
  if (event.entityType !== "issue") return;
  const issueId = typeof event.entityId === "string" ? event.entityId : null;
  if (!issueId) return;

  let pending: PendingReplyRow | null = null;
  try {
    pending = await loadPendingReplyForIssue(_db, issueId);
  } catch (err) {
    logger.debug({ err, issueId }, "agent-runtime-bridge: pending reply lookup failed");
    return;
  }
  if (!pending) return;

  const issue = await loadIssueRow(_db, issueId);
  if (!issue) {
    await deletePendingReply(_db, issueId);
    return;
  }

  const terminal =
    issue.status === "done" ||
    issue.status === "cancelled" ||
    issue.status === "blocked";
  if (!terminal) return;

  try {
    await publishA2AReply(pending, issue);
  } finally {
    await deletePendingReply(_db, issueId);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Wire the runtime bridge. Idempotent — re-invocations replace the previous
 * subscription set with a freshly recomputed one. Safe to call before the
 * MQTT singleton has connected; in that case the bridge logs and stays idle
 * until the next event or restart.
 */
export async function wireAgentRuntimeBridge(db: Db): Promise<void> {
  _db = db;
  if (_started) return;
  _started = true;

  if (!isMqttInitialised()) {
    logger.info(
      "agent-runtime-bridge: MQTT not initialised, skipping initial subscription pass",
    );
    return;
  }

  // Phase 1.10 — bootstrap all six addressing dimensions for every
  // non-archived agent. Three queries do the work: holacracy slots (role +
  // circle), agents.accountabilities (skill slugs), and any ungoverned
  // agents that have accountabilities but no role assignment (still
  // reachable via the skill bus).
  let slots: AgentSlotRow[] = [];
  try {
    slots = await loadAllAgentSlots(db);
  } catch (err) {
    logger.warn({ err }, "agent-runtime-bridge: initial slot load failed");
  }
  let skills: AgentSkillRow[] = [];
  try {
    skills = await loadAllAgentSkills(db);
  } catch (err) {
    logger.warn({ err }, "agent-runtime-bridge: initial skill load failed");
  }

  const agentIds = new Set<string>();
  for (const s of slots) agentIds.add(s.agentId);
  for (const s of skills) agentIds.add(s.agentId);

  const perAgentMode = perAgentClientManager.mode();
  logger.info(
    {
      agentCount: agentIds.size,
      slotCount: slots.length,
      skillRows: skills.length,
      perAgentMode,
    },
    `agent-runtime-bridge: ${perAgentMode} mode active`,
  );
  for (const agentId of agentIds) {
    try {
      await reconcileAgentSubscriptions(agentId);
    } catch (err) {
      logger.warn({ err, agentId }, "agent-runtime-bridge: bootstrap reconcile failed");
    }
  }
}

/**
 * Public hook called by `mqtt/bridge.ts` when a role-assignment event fires
 * — keeps the per-agent subscription set in sync with DB membership without
 * a process restart.
 */
export async function reconcileAgentRuntimeSubscriptions(
  agentId: string,
): Promise<void> {
  try {
    await reconcileAgentSubscriptions(agentId);
  } catch (err) {
    logger.warn({ err, agentId }, "agent-runtime-bridge: reconcile failed");
  }
}

/** Graceful shutdown — invoked from SIGINT/SIGTERM handlers in `index.ts`. */
export async function shutdownAgentRuntimeBridge(): Promise<void> {
  const handles = [..._subscriptionsByTopic.values()];
  _subscriptionsByTopic.clear();
  for (const handle of handles) {
    try {
      await handle.unsubscribe();
    } catch (err) {
      logger.debug({ err }, "agent-runtime-bridge: shutdown unsubscribe failed");
    }
  }
  _started = false;
  _db = null;
}

/** **Test-only.** Reset module state so unit tests can re-wire from scratch. */
export function _resetForTesting(): void {
  _subscriptionsByTopic.clear();
  _started = false;
  _db = null;
}
