/**
 * Phase 1.13 — Eyes: per-agent neighbourhood snapshot.
 *
 * Composes a small bundle of peripheral awareness that gets prepended to the
 * agent's run context the next time it wakes for any reason. The point is
 * peripheral awareness, not a data dump — every list is truncated to 20
 * entries, and the rendered markdown is bounded at ~200 lines.
 *
 * Sources (all best-effort; any failure logs a debug + returns an empty
 * subsection so the run never blocks on snapshot assembly):
 *  - `companies.{...}` + plugin-holacracy joins (same loaders as the DNA
 *    projector) for the latest DNA envelope.
 *  - `agents` × `plugin-holacracy.role_assignments` × `circles` to list other
 *    agents in any circle this agent is in.
 *  - `agent_perceptions` for unconsumed broadcasts (then mark consumed).
 *  - Recent broadcasts on this agent's circles for "what just happened" (we
 *    derive this from `agent_perceptions` rather than the broker because the
 *    broker doesn't retain non-DNA event topics).
 *
 * The snapshot generation hash is exported so the prompt cache can invalidate
 * on a new perception or DNA mutation.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getCompanyDna, type DnaEnvelope } from "../services/company-dna.js";

const MAX_NEIGHBOURS = 20;
const MAX_PERCEPTIONS = 20;
const MAX_RECENT_PULSES = 20;
const MAX_ACTIVE_DISCUSSIONS = 10;
const MAX_TRUST_SIGNALS = 10;

export interface NeighbourEntry {
  id: string;
  name: string;
  title: string | null;
  accountabilities: Array<Record<string, unknown>>;
  lastHeartbeatAt: string | null;
  circleId: string;
  circleName: string | null;
}

export interface PerceptionEntry {
  id: string;
  topic: string;
  payloadJson: unknown;
  userProperties: Record<string, unknown> | null;
  receivedAt: string;
}

export interface RecentPulseEntry {
  topic: string;
  payloadJson: unknown;
  receivedAt: string;
  circleId: string | null;
}

export interface ActiveDiscussionEntry {
  id: string;
  topic: string;
  speakerMode: string;
  roundsPlanned: number;
  roundsCompleted: number;
  phase: string;
  yourTurnNow: boolean;
  /** True if this agent is the current speaker (sequential modes) or the
   *  round is still open (parallel). */
  awaitingYou: boolean;
  contextId: string;
  startedAt: string;
}

export interface TrustSignalEntry {
  trustedAgentId: string;
  trustedAgentName: string | null;
  skillSlug: string;
  successfulExchanges: number;
  failedExchanges: number;
}

export interface NeighbourhoodSnapshot {
  agentId: string;
  companyId: string;
  generatedAt: string;
  dna: DnaEnvelope | null;
  neighbours: NeighbourEntry[];
  recentPulses: RecentPulseEntry[];
  unconsumedPerceptions: PerceptionEntry[];
  activeDiscussions: ActiveDiscussionEntry[];
  trustSignals: TrustSignalEntry[];
  /** Stable hash of the rendered content; the adapter cache keys off this so
   *  a fresh perception or DNA mutation invalidates the cached prompt. */
  contentHash: string;
}

interface AgentRow extends Record<string, unknown> {
  companyId: string;
}

async function loadAgentCompanyId(db: Db, agentId: string): Promise<string | null> {
  try {
    const rows = await db.execute<AgentRow>(sql`
      SELECT company_id::text AS "companyId"
      FROM public.agents
      WHERE id = ${agentId}::uuid
      LIMIT 1
    `);
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: AgentRow[] }).rows ?? [];
    return list[0]?.companyId ?? null;
  } catch (err) {
    logger.debug({ err, agentId }, "neighbourhood: agent company lookup failed");
    return null;
  }
}

async function loadNeighbours(db: Db, agentId: string): Promise<NeighbourEntry[]> {
  // For every circle this agent has a role assignment in, list every OTHER
  // agent with a role assignment in the same circle (with their
  // accountabilities + last-heartbeat for "are they alive"). Each (agent,
  // circle) pair is one row — the same agent may appear multiple times if
  // it's in multiple shared circles.
  try {
    interface Row extends Record<string, unknown> {
      id: string;
      name: string;
      title: string | null;
      accountabilities: Array<Record<string, unknown>> | null;
      lastHeartbeatAt: string | null;
      circleId: string;
      circleName: string | null;
    }
    const rows = await db.execute<Row>(sql`
      WITH my_circles AS (
        SELECT DISTINCT c.id AS circle_id, c.name AS circle_name
        FROM plugin_holacracy_c5049b5dfe.role_assignments ra
        JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
        JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
        WHERE ra.agent_id = ${agentId}::uuid
      )
      SELECT DISTINCT
        a.id::text                                                     AS "id",
        a.name                                                         AS "name",
        a.title                                                        AS "title",
        COALESCE(a.accountabilities, '[]'::jsonb)                      AS "accountabilities",
        a.last_heartbeat_at::text                                      AS "lastHeartbeatAt",
        mc.circle_id::text                                             AS "circleId",
        mc.circle_name                                                 AS "circleName"
      FROM plugin_holacracy_c5049b5dfe.role_assignments ra
      JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
      JOIN public.agents a ON a.id = ra.agent_id
      JOIN my_circles mc ON mc.circle_id = r.circle_id
      WHERE a.id != ${agentId}::uuid
        AND a.status NOT IN ('archived', 'terminated')
      ORDER BY "name" ASC
      LIMIT ${MAX_NEIGHBOURS}
    `);
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((r): NeighbourEntry => ({
      id: r.id,
      name: r.name,
      title: r.title,
      accountabilities: Array.isArray(r.accountabilities) ? r.accountabilities : [],
      lastHeartbeatAt: r.lastHeartbeatAt,
      circleId: r.circleId,
      circleName: r.circleName,
    }));
  } catch (err) {
    logger.debug({ err, agentId }, "neighbourhood: neighbour lookup failed");
    return [];
  }
}

async function loadRecentPulses(db: Db, agentId: string): Promise<RecentPulseEntry[]> {
  // Recent tactical/governance pulses on the agent's circles. We pull from
  // `agent_perceptions` (consumed OR unconsumed) filtered to the
  // tactical-pulse / governance-pulse event sub-channels, capped at 20. This
  // gives the LLM "what happened recently in my circles" without forcing it
  // to query the broker.
  try {
    interface Row extends Record<string, unknown> {
      topic: string;
      payloadJson: unknown;
      receivedAt: string;
    }
    const rows = await db.execute<Row>(sql`
      SELECT
        topic                       AS "topic",
        payload_json                AS "payloadJson",
        received_at::text           AS "receivedAt"
      FROM public.agent_perceptions
      WHERE agent_id = ${agentId}::uuid
        AND (
          topic LIKE '%/tactical-pulse'
          OR topic LIKE '%/governance-pulse'
          OR topic LIKE '%/announce'
        )
      ORDER BY received_at DESC
      LIMIT ${MAX_RECENT_PULSES}
    `);
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((r): RecentPulseEntry => ({
      topic: r.topic,
      payloadJson: r.payloadJson,
      receivedAt: r.receivedAt,
      circleId: extractCircleIdFromTopic(r.topic),
    }));
  } catch (err) {
    logger.debug({ err, agentId }, "neighbourhood: recent pulses lookup failed");
    return [];
  }
}

async function consumePerceptions(db: Db, agentId: string): Promise<PerceptionEntry[]> {
  // Read unconsumed perceptions and mark them consumed in one round-trip.
  // We use UPDATE ... RETURNING so concurrent runs of the same agent don't
  // double-consume the same row.
  try {
    interface Row extends Record<string, unknown> {
      id: string;
      topic: string;
      payloadJson: unknown;
      userProperties: Record<string, unknown> | null;
      receivedAt: string;
    }
    const rows = await db.execute<Row>(sql`
      WITH eligible AS (
        SELECT id
        FROM public.agent_perceptions
        WHERE agent_id = ${agentId}::uuid AND consumed_at IS NULL
        ORDER BY received_at ASC
        LIMIT ${MAX_PERCEPTIONS}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.agent_perceptions p
      SET consumed_at = NOW()
      FROM eligible e
      WHERE p.id = e.id
      RETURNING
        p.id::text          AS "id",
        p.topic             AS "topic",
        p.payload_json      AS "payloadJson",
        p.user_properties   AS "userProperties",
        p.received_at::text AS "receivedAt"
    `);
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((r): PerceptionEntry => ({
      id: r.id,
      topic: r.topic,
      payloadJson: r.payloadJson,
      userProperties: r.userProperties,
      receivedAt: r.receivedAt,
    }));
  } catch (err) {
    logger.debug({ err, agentId }, "neighbourhood: perception consume failed");
    return [];
  }
}

async function loadActiveDiscussions(
  db: Db,
  agentId: string,
): Promise<ActiveDiscussionEntry[]> {
  try {
    interface Row extends Record<string, unknown> {
      id: string;
      topic: string;
      speakerMode: string;
      roundsPlanned: number;
      roundsCompleted: number;
      phase: string;
      currentSpeakerIdx: number;
      speakerOrder: string[] | null;
      participantAgentIds: string[];
      contextId: string;
      startedAt: string;
    }
    const rows = await db.execute<Row>(sql`
      SELECT
        id::text                    AS "id",
        topic                       AS "topic",
        speaker_mode                AS "speakerMode",
        rounds_planned              AS "roundsPlanned",
        rounds_completed            AS "roundsCompleted",
        phase                       AS "phase",
        current_speaker_idx         AS "currentSpeakerIdx",
        speaker_order               AS "speakerOrder",
        participant_agent_ids       AS "participantAgentIds",
        a2a_context_id              AS "contextId",
        started_at::text            AS "startedAt"
      FROM public.circle_discussions
      WHERE status = 'open'
        AND ${agentId}::uuid = ANY(participant_agent_ids)
      ORDER BY started_at DESC
      LIMIT ${MAX_ACTIVE_DISCUSSIONS}
    `);
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((r): ActiveDiscussionEntry => {
      const order = Array.isArray(r.speakerOrder) && r.speakerOrder.length > 0
        ? r.speakerOrder
        : r.participantAgentIds;
      const currentSpeaker = order[r.currentSpeakerIdx ?? 0] ?? null;
      const yourTurnNow = r.speakerMode !== "parallel" && currentSpeaker === agentId;
      const awaitingYou =
        r.phase === "open"
          ? (r.speakerMode === "parallel" ? true : yourTurnNow)
          : r.phase === "awaiting_commitments";
      return {
        id: r.id,
        topic: r.topic,
        speakerMode: r.speakerMode,
        roundsPlanned: r.roundsPlanned,
        roundsCompleted: r.roundsCompleted,
        phase: r.phase,
        yourTurnNow,
        awaitingYou,
        contextId: r.contextId,
        startedAt: r.startedAt,
      };
    });
  } catch (err) {
    logger.debug({ err, agentId }, "neighbourhood: active-discussions load failed");
    return [];
  }
}

async function loadTrustSignals(db: Db, agentId: string): Promise<TrustSignalEntry[]> {
  try {
    interface Row extends Record<string, unknown> {
      trustedAgentId: string;
      trustedAgentName: string | null;
      skillSlug: string;
      successfulExchanges: number;
      failedExchanges: number;
    }
    const rows = await db.execute<Row>(sql`
      SELECT
        t.trusted_agent_id::text  AS "trustedAgentId",
        a.name                    AS "trustedAgentName",
        t.skill_slug              AS "skillSlug",
        t.successful_exchanges    AS "successfulExchanges",
        t.failed_exchanges        AS "failedExchanges"
      FROM public.agent_trust_signals t
      LEFT JOIN public.agents a ON a.id = t.trusted_agent_id
      WHERE t.truster_agent_id = ${agentId}::uuid
      ORDER BY t.last_exchange_at DESC NULLS LAST
      LIMIT ${MAX_TRUST_SIGNALS}
    `);
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((r): TrustSignalEntry => ({
      trustedAgentId: r.trustedAgentId,
      trustedAgentName: r.trustedAgentName,
      skillSlug: r.skillSlug,
      successfulExchanges: r.successfulExchanges,
      failedExchanges: r.failedExchanges,
    }));
  } catch (err) {
    logger.debug({ err, agentId }, "neighbourhood: trust-signals load failed");
    return [];
  }
}

function extractCircleIdFromTopic(topic: string): string | null {
  // paperclip/v1/event/{companyId}/{circleId}/{channel}
  const parts = topic.split("/");
  if (parts.length >= 5 && parts[0] === "paperclip" && parts[1] === "v1" && parts[2] === "event") {
    return parts[4] ?? null;
  }
  return null;
}

function computeContentHash(snapshot: Omit<NeighbourhoodSnapshot, "contentHash">): string {
  const hash = createHash("sha256");
  hash.update("paperclip-neighbourhood-snapshot:v1\n");
  hash.update(snapshot.agentId);
  hash.update("\n");
  hash.update(snapshot.companyId);
  hash.update("\n");
  if (snapshot.dna) {
    hash.update(`dna-generation:${snapshot.dna.generation}\n`);
    hash.update(snapshot.dna.mutated_at ?? "");
    hash.update("\n");
  }
  for (const n of snapshot.neighbours) {
    hash.update(`n:${n.id}:${n.circleId}:${n.lastHeartbeatAt ?? ""}\n`);
  }
  for (const p of snapshot.unconsumedPerceptions) {
    hash.update(`p:${p.id}\n`);
  }
  for (const r of snapshot.recentPulses) {
    hash.update(`r:${r.topic}:${r.receivedAt}\n`);
  }
  for (const d of snapshot.activeDiscussions) {
    hash.update(`d:${d.id}:${d.phase}:${d.roundsCompleted}:${d.yourTurnNow ? "1" : "0"}\n`);
  }
  for (const t of snapshot.trustSignals) {
    hash.update(`t:${t.trustedAgentId}:${t.skillSlug}:${t.successfulExchanges}:${t.failedExchanges}\n`);
  }
  return hash.digest("hex");
}

/**
 * Assemble the neighbourhood snapshot for one agent. The function is
 * intentionally cheap (a handful of best-effort SQL queries) and never
 * throws — every internal failure logs a debug entry and returns an empty
 * subsection. Boot order: this is safe to call even if the plugin-holacracy
 * schema isn't installed yet (the circle/role joins return empty).
 */
export async function buildNeighbourhoodSnapshot(
  db: Db,
  agentId: string,
): Promise<NeighbourhoodSnapshot | null> {
  const companyId = await loadAgentCompanyId(db, agentId);
  if (!companyId) {
    logger.debug({ agentId }, "neighbourhood: agent not found, skipping snapshot");
    return null;
  }

  const generatedAt = new Date().toISOString();
  // Run loaders in parallel. consumePerceptions has a side-effect
  // (the UPDATE) but is otherwise independent.
  const [dna, neighbours, recentPulses, unconsumedPerceptions, activeDiscussions, trustSignals] = await Promise.all([
    getCompanyDna(db, companyId).catch((err) => {
      logger.debug({ err, companyId }, "neighbourhood: DNA load failed");
      return null;
    }),
    loadNeighbours(db, agentId),
    loadRecentPulses(db, agentId),
    consumePerceptions(db, agentId),
    loadActiveDiscussions(db, agentId),
    loadTrustSignals(db, agentId),
  ]);

  const partial: Omit<NeighbourhoodSnapshot, "contentHash"> = {
    agentId,
    companyId,
    generatedAt,
    dna,
    neighbours: neighbours.slice(0, MAX_NEIGHBOURS),
    recentPulses: recentPulses.slice(0, MAX_RECENT_PULSES),
    unconsumedPerceptions: unconsumedPerceptions.slice(0, MAX_PERCEPTIONS),
    activeDiscussions: activeDiscussions.slice(0, MAX_ACTIVE_DISCUSSIONS),
    trustSignals: trustSignals.slice(0, MAX_TRUST_SIGNALS),
  };
  return {
    ...partial,
    contentHash: computeContentHash(partial),
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function renderAccountabilities(accs: Array<Record<string, unknown>>): string {
  if (accs.length === 0) return "—";
  return accs
    .slice(0, 3)
    .map((a) => (typeof a.name === "string" && a.name.trim().length > 0 ? a.name.trim() : "?"))
    .join(", ");
}

function renderPerceptionBody(payload: unknown): string {
  if (payload === null || payload === undefined) return "(empty)";
  if (typeof payload === "string") return truncate(payload, 200);
  if (typeof payload === "object") {
    try {
      return truncate(JSON.stringify(payload), 200);
    } catch {
      return "(unserialisable)";
    }
  }
  return String(payload);
}

/**
 * Render the snapshot as a compact markdown block suitable for prepending to
 * the agent's instructions. Bounded to ~200 lines via the per-list caps.
 */
export function renderNeighbourhoodMarkdown(snapshot: NeighbourhoodSnapshot): string {
  const lines: string[] = [];
  lines.push(`## Neighbourhood snapshot (T=${snapshot.generatedAt})`);
  lines.push("");
  lines.push(
    "_This snapshot was assembled from the company DNA, your circle members, " +
      "recent broadcasts on your circles, and any peer messages addressed to " +
      "you since you last ran. It's peripheral awareness — act on it only when " +
      "it's directly relevant to your task._",
  );
  lines.push("");

  // DNA section
  lines.push("### Your company DNA");
  if (snapshot.dna) {
    const d = snapshot.dna;
    lines.push(`- **Name**: ${d.identity.name}`);
    if (d.identity.mission_statement) {
      lines.push(`- **Mission**: ${truncate(d.identity.mission_statement, 300)}`);
    }
    if (d.identity.values && d.identity.values.length > 0) {
      lines.push(`- **Values**: ${d.identity.values.slice(0, 8).join(", ")}`);
    }
    lines.push(`- **Governance**: ${d.constitution.governance} over ${d.constitution.transport}`);
    lines.push(`- **DNA generation**: ${d.generation}${d.mutated_at ? ` (last mutated ${d.mutated_at})` : ""}`);
    if (d.policies.length > 0) {
      lines.push(`- **Company policies (${d.policies.length})**:`);
      for (const p of d.policies.slice(0, 5)) {
        lines.push(`  - ${truncate(p.title, 80)}`);
      }
    }
  } else {
    lines.push("_(DNA envelope unavailable)_");
  }
  lines.push("");

  // Neighbours
  lines.push(`### Agents you know (${snapshot.neighbours.length})`);
  if (snapshot.neighbours.length === 0) {
    lines.push("_(no circle neighbours)_");
  } else {
    for (const n of snapshot.neighbours) {
      const idPrefix = n.id.slice(0, 8);
      const circle = n.circleName ? ` [in ${n.circleName}]` : "";
      const heartbeat = n.lastHeartbeatAt
        ? ` last-seen=${n.lastHeartbeatAt}`
        : " never-seen";
      lines.push(
        `- **${n.name}** (${idPrefix})${circle} — ${renderAccountabilities(n.accountabilities)}${heartbeat}`,
      );
    }
  }
  lines.push("");

  // Recent broadcasts
  lines.push(`### Recent broadcasts in your circles (${snapshot.recentPulses.length})`);
  if (snapshot.recentPulses.length === 0) {
    lines.push("_(no recent broadcasts)_");
  } else {
    for (const r of snapshot.recentPulses) {
      const channel = r.topic.split("/").slice(-1)[0] ?? r.topic;
      lines.push(`- T=${r.receivedAt} kind=${channel} ${renderPerceptionBody(r.payloadJson)}`);
    }
  }
  lines.push("");

  // Active conversations (unconsumed perceptions)
  lines.push(`### Active conversations (${snapshot.unconsumedPerceptions.length} new since last run)`);
  if (snapshot.unconsumedPerceptions.length === 0) {
    lines.push("_(no new direct messages)_");
  } else {
    for (const p of snapshot.unconsumedPerceptions) {
      const channel = p.topic.split("/").slice(-1)[0] ?? p.topic;
      const from = p.userProperties && typeof p.userProperties === "object"
        ? (p.userProperties as Record<string, unknown>).publisherAgentId
        : null;
      const fromStr = typeof from === "string" ? ` from=${from.slice(0, 8)}` : "";
      lines.push(`- T=${p.receivedAt} kind=${channel}${fromStr} ${renderPerceptionBody(p.payloadJson)}`);
    }
  }
  lines.push("");

  // Active discussions you're in (Phase 1.14)
  lines.push(`### Active discussions you're in (${snapshot.activeDiscussions.length})`);
  if (snapshot.activeDiscussions.length === 0) {
    lines.push("_(no active discussions)_");
  } else {
    for (const d of snapshot.activeDiscussions) {
      const turnFlag = d.yourTurnNow
        ? " **— YOUR TURN NOW**"
        : d.awaitingYou
          ? " — awaiting your input"
          : "";
      lines.push(
        `- **${truncate(d.topic, 80)}** [${d.speakerMode}] round ${d.roundsCompleted}/${d.roundsPlanned} phase=${d.phase}${turnFlag}`,
      );
    }
  }
  lines.push("");

  // Trust signals (Phase 1.15f) — who you trust for what.
  lines.push(`### Trust signals (${snapshot.trustSignals.length})`);
  if (snapshot.trustSignals.length === 0) {
    lines.push("_(no trust history yet — every exchange builds the file)_");
  } else {
    for (const t of snapshot.trustSignals) {
      const name = t.trustedAgentName ?? t.trustedAgentId.slice(0, 8);
      const ratio = `${t.successfulExchanges}/${t.failedExchanges}`;
      lines.push(`- **${name}** — ${t.skillSlug} (${ratio} successes/failures)`);
    }
  }
  lines.push("");

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}
