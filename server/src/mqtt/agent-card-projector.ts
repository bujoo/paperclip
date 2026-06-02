/**
 * Agent Card projector — owns publishing of retained A2A v1.0 Agent Cards on
 * the `paperclip/v1/discovery/{companyId}/{circleId}/{agentId}` topic.
 *
 * The Paperclip host singleton publishes Agent Cards on behalf of every
 * managed agent. Plugin workers and external A2A agents never write to the
 * discovery topic directly — that's the projector's job, so the broker holds
 * a single source-of-truth retained payload per `(companyId, circleId, agentId)`
 * tuple.
 *
 * Lifecycle triggers (called from `mqtt/bridge.ts`):
 *  - `agent.created`, `agent.updated`, `agent.status_changed` — (re)project all
 *    cards for the affected agent across every circle it's assigned to.
 *  - `role_assignment.created` / `role_assignment.deleted` (plugin-holacracy
 *    namespaced) — (re)project just the affected `(circleId, agentId)` slot,
 *    deregistering when no roles remain.
 *  - `agent.paused` (status_changed → paused) — publish offline-status card
 *    retained, so subscribers see the agent as unreachable but the slot
 *    remains claimed.
 *  - `agent.archived` (status_changed → terminated) — publish empty retained
 *    payload, fully deregistering the slot from the broker.
 *
 * The DB layout poses a wrinkle: circles, roles, and role_assignments live in
 * the plugin-holacracy plugin namespace (`plugin_holacracy_c5049b5dfe.*`),
 * not the public schema. This projector reads via a raw SQL query against the
 * plugin schema so it doesn't depend on the holacracy plugin being loaded.
 * If the plugin is not installed (i.e. the schema doesn't exist), the query
 * fails gracefully and the projector publishes an unscoped card under a
 * synthetic "default" circle id derived from the agent's companyId — that
 * keeps round 2 functional before the holacracy plugin ships.
 */

import type { Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { sql } from "drizzle-orm";
import {
  discoveryTopic,
  publishRetained,
} from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";
import {
  isMqttInitialised,
  publishRetainedMessage,
} from "./client.js";
import { invalidateAclCache } from "./acl-backend.js";
import { reconcileAgentRuntimeSubscriptions } from "./agent-runtime-bridge.js";
import * as perAgentClientManager from "./per-agent-client-manager.js";
import { coerceRowsList } from "../util/db.js";

// ---------------------------------------------------------------------------
// Card schema (A2A v1.0 + paperclip extension)
// ---------------------------------------------------------------------------

/**
 * Skill entry on the Agent Card. A2A v1.0 requires `id`, `name`, `description`.
 * We derive these from the agent's accountabilities, treating the
 * accountability name as both `id` and `name` and the metric/target as the
 * description string.
 */
export interface PaperclipAgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

/**
 * Paperclip-specific extension carried on every Card. Subscribers that
 * understand this extension can use the deep metadata; vanilla A2A clients
 * ignore unknown fields.
 */
export interface PaperclipAgentCardExtension {
  companyId: string;
  circleId: string;
  agentId: string;
  status: string;
  roles: Array<{ id: string; name: string; purpose: string | null }>;
  accountabilities: Array<Record<string, unknown>>;
  /** Monotonic version derived from `agents.updated_at`. */
  version: string;
}

export interface PaperclipAgentCard {
  /** A2A v1.0 protocol version this Card conforms to. */
  protocolVersion: "1.0";
  /** Phase 1.16-EMQX E3 — Top-level identity fields per the EMQX A2A spec
   *  (`emqx-ai/a2a-over-mqtt/architecture.md`). The A2A Registry indexes
   *  these for cross-agent discovery + management API queries. Maps:
   *    org_id  = companyId
   *    unit_id = home circleId
   *    agent_id = agents.id
   *  Reproduced here at the top level (in addition to the
   *  `paperclip.*` namespace) so external A2A clients can read them
   *  without knowing Paperclip's extension shape. */
  org_id: string;
  unit_id: string;
  agent_id: string;
  /** Human-readable agent name. */
  name: string;
  /** Description combining `agents.title` with the most descriptive role purpose. */
  description: string;
  /** Version string — bumped on each re-projection so subscribers can tell when a Card has changed. */
  version: string;
  /** A2A v1.0 endpoint URL. Internal placeholder until external exposure ships. */
  url: string;
  /** Derived from `agents.accountabilities`. */
  skills: PaperclipAgentCardSkill[];
  /** Phase 1.16-EMQX E3 — Capabilities per the open A2A spec. `streaming:
   *  true` for bedrock_gateway / claude_local agents (Claude API streams);
   *  false for hermes_local (subprocess CLI, no native stream). */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  /** Paperclip-specific deep metadata, namespaced to avoid colliding with future A2A fields. */
  paperclip: PaperclipAgentCardExtension;
}

// ---------------------------------------------------------------------------
// Module wiring
// ---------------------------------------------------------------------------

/**
 * Set by `wireAgentCardProjector(db)` during server bootstrap so this module
 * can run DB queries without each event handler needing to thread the Db
 * through. Tests call `_resetForTesting()` to clear between runs.
 */
let _db: Db | null = null;

export function wireAgentCardProjector(db: Db): void {
  _db = db;
  // Phase 1.10 — bootstrap backfill. Pre-existing agents that have never
  // gone through a lifecycle event since the projector wired up have no
  // retained Card on the broker, which means external A2A clients (and our
  // own retained-subscription consumers) can't discover them. Fire and
  // forget; never block startup.
  if (isMqttInitialised()) {
    void backfillAgentCardsOnBootstrap(db).catch((err) => {
      logger.warn({ err }, "agent-card-projector: bootstrap backfill failed");
    });
  } else {
    logger.debug(
      "agent-card-projector: MQTT not initialised, skipping bootstrap backfill",
    );
  }
}

export function _resetForTesting(): void {
  _db = null;
}

// ---------------------------------------------------------------------------
// Bootstrap backfill
// ---------------------------------------------------------------------------

interface AgentIdRow extends Record<string, unknown> {
  id: string;
}

/**
 * Walk every non-archived agent in the DB and re-project its Agent Card.
 * Designed to be safe-on-repeat: each re-projection publishes to the same
 * retained topic, so the broker simply replaces the prior payload. Errors
 * are isolated per-agent — one bad row never aborts the whole loop.
 *
 * Called once from `wireAgentCardProjector` at bootstrap, and exposed via
 * `POST /api/internal/mqtt/reproject-all` for ops.
 */
export async function backfillAgentCardsOnBootstrap(db: Db): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  if (!isMqttInitialised()) {
    logger.info(
      "agent-card-projector: MQTT not initialised, skipping backfill",
    );
    return { attempted: 0, succeeded: 0, failed: 0 };
  }
  // Use the module-level _db if it's wired, otherwise the passed-in handle.
  // (Both should be the same instance once wireAgentCardProjector has run.)
  const dbHandle = _db ?? db;
  let rows: AgentIdRow[] = [];
  try {
    const result = await dbHandle.execute<AgentIdRow>(sql`
      SELECT id::text AS "id"
      FROM public.agents
      WHERE status != 'archived'
    `);
    rows = Array.isArray(result)
      ? result
      : (result as unknown as { rows: AgentIdRow[] }).rows ?? [];
  } catch (err) {
    logger.warn(
      { err },
      "agent-card-projector: failed to load agent list for backfill",
    );
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await reprojectAgentCard(row.id);
      succeeded += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, agentId: row.id },
        "agent-card-projector: backfill failed for agent",
      );
    }
  }
  logger.info(
    { attempted: rows.length, succeeded, failed },
    "agent-card-projector: bootstrap backfill complete",
  );
  return { attempted: rows.length, succeeded, failed };
}

// ---------------------------------------------------------------------------
// DB shapes — reads
// ---------------------------------------------------------------------------

interface AgentRow extends Record<string, unknown> {
  id: string;
  companyId: string;
  name: string;
  title: string | null;
  status: string;
  accountabilities: Array<Record<string, unknown>>;
  updatedAt: Date;
}

interface CircleRoleRow extends Record<string, unknown> {
  circleId: string;
  roleId: string;
  roleName: string;
  rolePurpose: string | null;
  circleName: string | null;
}

async function loadAgentById(agentId: string): Promise<AgentRow | null> {
  if (!_db) return null;
  const rows = await _db.execute<AgentRow>(sql`
    SELECT
      id::text AS "id",
      company_id::text AS "companyId",
      name AS "name",
      title AS "title",
      status AS "status",
      COALESCE(accountabilities, '[]'::jsonb) AS "accountabilities",
      updated_at AS "updatedAt"
    FROM public.agents
    WHERE id = ${agentId}::uuid
    LIMIT 1
  `);
  const list = coerceRowsList<AgentRow>(rows);
  return list[0] ?? null;
}

/**
 * Load every role-assignment slot for an agent from plugin-holacracy's
 * schema. Returns an empty array (NOT throw) if the schema doesn't exist —
 * that keeps the projector working before the holacracy plugin is installed.
 */
async function loadRoleAssignmentsForAgent(agentId: string): Promise<CircleRoleRow[]> {
  if (!_db) return [];
  try {
    const rows = await _db.execute<CircleRoleRow>(sql`
      SELECT
        c.id::text AS "circleId",
        r.id::text AS "roleId",
        r.name AS "roleName",
        r.purpose AS "rolePurpose",
        c.name AS "circleName"
      FROM plugin_holacracy_c5049b5dfe.role_assignments ra
      JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
      JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
      WHERE ra.agent_id = ${agentId}::uuid
    `);
    return coerceRowsList<CircleRoleRow>(rows);
  } catch (err) {
    // Schema not yet installed — that's the common case before plugin is loaded.
    logger.debug(
      { err, agentId },
      "agent-card-projector: holacracy schema unavailable, projecting with empty circle list",
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Card builder
// ---------------------------------------------------------------------------

function buildSkillsFromAccountabilities(
  accountabilities: Array<Record<string, unknown>>,
): PaperclipAgentCardSkill[] {
  return accountabilities.map((acc) => {
    const name = typeof acc.name === "string" ? acc.name : "accountability";
    const metric =
      typeof acc.metric === "string" ? acc.metric : JSON.stringify(acc.metric ?? "");
    const target =
      acc.target !== undefined && acc.target !== null ? String(acc.target) : "";
    const cadence = typeof acc.cadence === "string" ? acc.cadence : "";
    const description = [metric, target ? `target=${target}` : "", cadence ? `cadence=${cadence}` : ""]
      .filter(Boolean)
      .join("; ") || `Accountability ${name}`;
    return { id: name, name, description };
  });
}

function buildCard(args: {
  agent: AgentRow;
  circleId: string;
  roles: Array<{ id: string; name: string; purpose: string | null }>;
  rolePurposeForDescription: string | null;
}): PaperclipAgentCard {
  const { agent, circleId, roles, rolePurposeForDescription } = args;
  const titlePart = agent.title?.trim();
  const purposePart = rolePurposeForDescription?.trim();
  const description = [titlePart, purposePart].filter(Boolean).join(" — ") || agent.name;
  const version = String(agent.updatedAt instanceof Date ? agent.updatedAt.getTime() : agent.updatedAt);
  return {
    protocolVersion: "1.0",
    // Phase 1.16-EMQX E3 — A2A-spec top-level identity. EMQX A2A Registry
    // indexes these for cross-agent discovery + `emqx ctl a2a_registry
    // get <org> <unit> <agent>` lookups.
    org_id: agent.companyId,
    unit_id: circleId,
    agent_id: agent.id,
    name: agent.name,
    description,
    version,
    url: `mqtt://internal/${agent.id}`,
    skills: buildSkillsFromAccountabilities(agent.accountabilities ?? []),
    // All 15 agents are bedrock_gateway → Claude Code → Claude API streams.
    // If a non-streaming adapter ever returns, gate this on agent.adapterType.
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    paperclip: {
      companyId: agent.companyId,
      circleId,
      agentId: agent.id,
      status: agent.status,
      roles,
      accountabilities: agent.accountabilities ?? [],
      version,
    },
  };
}

// ---------------------------------------------------------------------------
// Status → A2A presence translation
// ---------------------------------------------------------------------------

/**
 * Map a Paperclip agent status to the `a2a-status` MQTT user property.
 * Returns `null` when the slot should be fully deregistered (empty retained
 * payload).
 */
function statusToA2APresence(status: string): "online" | "offline" | null {
  switch (status) {
    case "terminated":
      return null; // empty retained → full deregister
    case "paused":
    case "pending_approval":
      return "offline";
    default:
      return "online";
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function publishCard(card: PaperclipAgentCard, a2aStatus: "online" | "offline"): Promise<void> {
  const topic = discoveryTopic(card.paperclip.companyId, card.paperclip.circleId, card.paperclip.agentId);
  // Phase 1.11 — when the agent's own MQTT client is ready, publish the
  // retained Card under its identity so subscribers see `clientId =
  // {companyId}/{circleId}/{agentId}` as the publisher. The
  // `a2a-status-source` user property tells consumers which surface emitted
  // the Card: `agent` (own client), `host-fallback` (host singleton), or
  // `lwt` (broker LWT on disconnect).
  const ownClient = perAgentClientManager.tryGetClient(card.paperclip.agentId);
  if (ownClient) {
    await publishRetained(ownClient, topic, card, {
      contentType: "application/json",
      userProperties: {
        "a2a-status": a2aStatus,
        "a2a-status-source": "agent",
        publishedBy: "paperclip",
        version: card.version,
      },
    });
    return;
  }
  await publishRetainedMessage(topic, card, {
    contentType: "application/json",
    userProperties: {
      "a2a-status": a2aStatus,
      "a2a-status-source": "host-fallback",
      publishedBy: "paperclip",
      version: card.version,
    },
  });
}

async function publishDeregister(companyId: string, circleId: string, agentId: string): Promise<void> {
  const topic = discoveryTopic(companyId, circleId, agentId);
  // Retained empty payload tells the broker to drop the retained slot per MQTT spec.
  const ownClient = perAgentClientManager.tryGetClient(agentId);
  if (ownClient) {
    try {
      await ownClient.publishAsync(topic, Buffer.alloc(0), {
        qos: 1,
        retain: true,
        properties: {
          userProperties: {
            "a2a-status-source": "agent",
            publishedBy: "paperclip",
          },
        },
      });
      return;
    } catch (err) {
      logger.debug(
        { err, agentId },
        "agent-card-projector: own-client deregister failed; falling back to host singleton",
      );
    }
  }
  await publishRetainedMessage(topic, Buffer.alloc(0), {
    userProperties: {
      "a2a-status-source": "host-fallback",
      publishedBy: "paperclip",
    },
  });
}

// ---------------------------------------------------------------------------
// Public — single-agent projection
// ---------------------------------------------------------------------------

/**
 * (Re)project the Agent Card for a single `agentId` across all circles the
 * agent is currently assigned to. Safe to call multiple times — each call
 * overwrites the retained payload on each topic.
 *
 * If the agent has zero role assignments (e.g. holacracy plugin not installed,
 * or the agent has been unassigned from every role), this still publishes
 * one Card under a synthetic circle slot equal to the agent's companyId so
 * the discovery topic is observable in dev. When the agent is `terminated`,
 * all slots get an empty retained payload.
 */
export async function reprojectAgentCard(agentId: string): Promise<void> {
  if (!isMqttInitialised()) return;
  if (!_db) {
    logger.debug({ agentId }, "agent-card-projector: db not wired, skipping");
    return;
  }

  const agent = await loadAgentById(agentId);
  if (!agent) {
    logger.debug({ agentId }, "agent-card-projector: agent not found, skipping");
    return;
  }

  const presence = statusToA2APresence(agent.status);
  const slots = await loadRoleAssignmentsForAgent(agentId);

  if (slots.length === 0) {
    // Fallback: publish under the company id as a synthetic circle so the
    // discovery topic is at least observable for ungoverned agents.
    const syntheticCircleId = agent.companyId;
    if (presence === null) {
      await publishDeregister(agent.companyId, syntheticCircleId, agent.id);
      return;
    }
    const card = buildCard({
      agent,
      circleId: syntheticCircleId,
      roles: [],
      rolePurposeForDescription: null,
    });
    await publishCard(card, presence);
    return;
  }

  // Group role rows by circle so each circle gets one Card with multiple roles.
  const byCircle = new Map<
    string,
    Array<{ id: string; name: string; purpose: string | null }>
  >();
  for (const slot of slots) {
    const list = byCircle.get(slot.circleId) ?? [];
    list.push({ id: slot.roleId, name: slot.roleName, purpose: slot.rolePurpose });
    byCircle.set(slot.circleId, list);
  }

  for (const [circleId, roles] of byCircle) {
    if (presence === null) {
      await publishDeregister(agent.companyId, circleId, agent.id);
      continue;
    }
    const rolePurposeForDescription =
      roles.map((r) => r.purpose).find((p): p is string => Boolean(p && p.trim().length > 0)) ?? null;
    const card = buildCard({ agent, circleId, roles, rolePurposeForDescription });
    await publishCard(card, presence);
  }
}

// ---------------------------------------------------------------------------
// Event-driven dispatch — wired in by `mqtt/bridge.ts`
// ---------------------------------------------------------------------------

/**
 * Inspect a domain event and re-project Cards for whichever agent IDs it
 * touched. Currently:
 *
 *  - `agent.*` events project by `event.entityId` (the agent's UUID).
 *  - role_assignment.* events project by `payload.agentId`.
 */
export async function projectAgentCardForEvent(event: PluginEvent): Promise<void> {
  if (!isMqttInitialised()) return;

  let agentId: string | null = null;
  if (event.entityType === "agent" && typeof event.entityId === "string") {
    agentId = event.entityId;
  } else {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.agentId === "string") {
      agentId = payload.agentId;
    }
  }

  if (!agentId) {
    logger.debug(
      { eventId: event.eventId, eventType: event.eventType },
      "agent-card-projector: could not resolve agentId, skipping",
    );
    return;
  }

  // Phase 1.11 — open the per-agent connection (or close it on terminate)
  // BEFORE reprojecting, so the Card publish below routes through the
  // agent's own client when possible.
  const isTerminated =
    event.eventType === "agent.status_changed" &&
    typeof (event.payload as { status?: unknown } | undefined)?.status === "string" &&
    (event.payload as { status: string }).status === "terminated";
  if (isTerminated) {
    try {
      await perAgentClientManager.dropAgent(agentId);
    } catch (err) {
      logger.debug({ err, agentId }, "agent-card-projector: drop-on-terminate failed");
    }
  } else {
    try {
      await perAgentClientManager.ensureAgent(agentId);
    } catch (err) {
      logger.debug({ err, agentId }, "agent-card-projector: ensure-on-event failed");
    }
  }

  try {
    await reprojectAgentCard(agentId);
  } catch (err) {
    logger.warn(
      { err, agentId, eventId: event.eventId, eventType: event.eventType },
      "agent-card-projector: re-projection failed",
    );
  }

  // Phase 1.10 — when an agent's identity changes (accountabilities edits via
  // `agent.updated`, role moves via `role_assignment.*`) the ACL cache and the
  // runtime-bridge subscription set both need to recompute. The bridge.ts
  // dispatcher already triggers these for role_assignment.* events; doing it
  // here too centralises the "agent identity changed" semantics so an
  // `agent.updated` with edited accountabilities also flows through.
  try {
    invalidateAclCache(agentId);
  } catch (err) {
    logger.debug({ err, agentId }, "agent-card-projector: ACL cache invalidate failed");
  }
  try {
    await reconcileAgentRuntimeSubscriptions(agentId);
  } catch (err) {
    logger.debug(
      { err, agentId },
      "agent-card-projector: runtime subscription reconcile failed",
    );
  }
}
