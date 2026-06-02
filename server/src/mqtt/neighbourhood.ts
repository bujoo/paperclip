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
import { coerceRowsList, safeLoad } from "../util/db.js";

const MAX_NEIGHBOURS = 20;
const MAX_PERCEPTIONS = 20;
const MAX_RECENT_PULSES = 20;
const MAX_ACTIVE_DISCUSSIONS = 10;
const MAX_TRUST_SIGNALS = 10;
const MAX_MY_ROLES = 5;
const MAX_STRATEGIES_PER_CIRCLE = 3;
const MAX_ACCOUNTABILITIES_SHOWN = 5;
const MAX_DOMAINS_SHOWN = 3;
const METRIC_LOOKBACK_DAYS = 14;
const CHECKLIST_LOOKBACK_DAYS = 14;
const MAX_METRICS = 10;
const MAX_CHECKLISTS = 10;

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
  /** T2 (Phase 1.15h-l) — the circle this discussion belongs to, so agents
   *  can pass it as `circleId` to raiseTension / broadcast etc. without
   *  having to derive it from elsewhere. */
  circleId: string;
  circleName: string | null;
  /** F9 (Phase 1.15h-l) — the proposer (per Holacracy, the agent who tabled the
   *  tension for this discussion). Sourced from `circle_discussions.initiated_by_agent_id`
   *  until F7 lands its own `proposer_agent_id` column. */
  proposerAgentId: string | null;
  proposerAgentName: string | null;
  /** F9 — count of unresolved objections + blocks (commitments where signal
   *  is 'block' or 'support-with-objection'). Lets Facilitator + proposer see
   *  how much integration work remains; lets non-proposers see whether their
   *  reaction round produced contention. */
  openObjectionCount: number;
}

export interface TrustSignalEntry {
  trustedAgentId: string;
  trustedAgentName: string | null;
  skillSlug: string;
  successfulExchanges: number;
  failedExchanges: number;
}

export interface MyRoleEntry {
  roleId: string;
  roleName: string;
  roleType: string;
  purpose: string | null;
  accountabilities: string[];
  domains: string[];
  circleId: string;
  circleName: string | null;
}

export interface StrategyEntry {
  id: string;
  circleId: string;
  circleName: string | null;
  text: string;
  setBy: string | null;
  setByName: string | null;
  createdAt: string;
}

export interface MetricEntry {
  metricId: string;
  metricName: string;
  unit: string | null;
  circleId: string;
  circleName: string | null;
  latestValue: number | null;
  latestPeriod: string | null;
  priorValue: number | null;
  trend: "up" | "down" | "flat" | "unknown";
}

export interface ChecklistEntry {
  checklistId: string;
  itemText: string;
  circleId: string;
  circleName: string | null;
  checkedCount: number;
  totalCount: number;
  latestPeriod: string | null;
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
  myRoles: MyRoleEntry[];
  strategies: StrategyEntry[];
  metrics: MetricEntry[];
  checklists: ChecklistEntry[];
  /** Stable hash of the rendered content; the adapter cache keys off this so
   *  a fresh perception or DNA mutation invalidates the cached prompt. */
  contentHash: string;
}

interface AgentRow extends Record<string, unknown> {
  companyId: string;
}

async function loadAgentCompanyId(db: Db, agentId: string): Promise<string | null> {
  return safeLoad(async () => {
    const rows = await db.execute<AgentRow>(sql`
      SELECT company_id::text AS "companyId"
      FROM public.agents
      WHERE id = ${agentId}::uuid
      LIMIT 1
    `);
    return coerceRowsList<AgentRow>(rows)[0]?.companyId ?? null;
  }, null, { logger, message: "neighbourhood: agent company lookup failed", context: { agentId } });
}

async function loadNeighbours(db: Db, agentId: string): Promise<NeighbourEntry[]> {
  // For every circle this agent has a role assignment in, list every OTHER
  // agent with a role assignment in the same circle (with their
  // accountabilities + last-heartbeat for "are they alive"). Each (agent,
  // circle) pair is one row — the same agent may appear multiple times if
  // it's in multiple shared circles.
  interface Row extends Record<string, unknown> {
    id: string;
    name: string;
    title: string | null;
    accountabilities: Array<Record<string, unknown>> | null;
    lastHeartbeatAt: string | null;
    circleId: string;
    circleName: string | null;
  }
  return safeLoad(async () => {
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
    return coerceRowsList<Row>(rows).map((r): NeighbourEntry => ({
      id: r.id,
      name: r.name,
      title: r.title,
      accountabilities: Array.isArray(r.accountabilities) ? r.accountabilities : [],
      lastHeartbeatAt: r.lastHeartbeatAt,
      circleId: r.circleId,
      circleName: r.circleName,
    }));
  }, [], { logger, message: "neighbourhood: neighbour lookup failed", context: { agentId } });
}

async function loadRecentPulses(db: Db, agentId: string): Promise<RecentPulseEntry[]> {
  // Recent tactical/governance pulses on the agent's circles. We pull from
  // `agent_perceptions` (consumed OR unconsumed) filtered to the
  // tactical-pulse / governance-pulse event sub-channels, capped at 20. This
  // gives the LLM "what happened recently in my circles" without forcing it
  // to query the broker.
  interface Row extends Record<string, unknown> {
    topic: string;
    payloadJson: unknown;
    receivedAt: string;
  }
  return safeLoad(async () => {
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
    return coerceRowsList<Row>(rows).map((r): RecentPulseEntry => ({
      topic: r.topic,
      payloadJson: r.payloadJson,
      receivedAt: r.receivedAt,
      circleId: extractCircleIdFromTopic(r.topic),
    }));
  }, [], { logger, message: "neighbourhood: recent pulses lookup failed", context: { agentId } });
}

async function consumePerceptions(db: Db, agentId: string): Promise<PerceptionEntry[]> {
  // Read unconsumed perceptions and mark them consumed in one round-trip.
  // We use UPDATE ... RETURNING so concurrent runs of the same agent don't
  // double-consume the same row.
  interface Row extends Record<string, unknown> {
    id: string;
    topic: string;
    payloadJson: unknown;
    userProperties: Record<string, unknown> | null;
    receivedAt: string;
  }
  return safeLoad(async () => {
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
    return coerceRowsList<Row>(rows).map((r): PerceptionEntry => ({
      id: r.id,
      topic: r.topic,
      payloadJson: r.payloadJson,
      userProperties: r.userProperties,
      receivedAt: r.receivedAt,
    }));
  }, [], { logger, message: "neighbourhood: perception consume failed", context: { agentId } });
}

async function loadActiveDiscussions(
  db: Db,
  agentId: string,
): Promise<ActiveDiscussionEntry[]> {
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
    circleId: string;
    circleName: string | null;
    proposerAgentId: string | null;
    proposerAgentName: string | null;
    openObjectionCount: number;
  }
  return safeLoad(async () => {
    const rows = await db.execute<Row>(sql`
      SELECT
        d.id::text                    AS "id",
        d.topic                       AS "topic",
        d.speaker_mode                AS "speakerMode",
        d.rounds_planned              AS "roundsPlanned",
        d.rounds_completed            AS "roundsCompleted",
        d.phase                       AS "phase",
        d.current_speaker_idx         AS "currentSpeakerIdx",
        d.speaker_order               AS "speakerOrder",
        d.participant_agent_ids       AS "participantAgentIds",
        d.a2a_context_id              AS "contextId",
        d.started_at::text            AS "startedAt",
        d.circle_id::text             AS "circleId",
        c.name                        AS "circleName",
        d.initiated_by_agent_id::text AS "proposerAgentId",
        p.name                        AS "proposerAgentName",
        COALESCE((
          SELECT COUNT(*)::int
          FROM public.discussion_commitments dc
          WHERE dc.discussion_id = d.id
            AND dc.signal IN ('block', 'support-with-objection')
        ), 0)                         AS "openObjectionCount"
      FROM public.circle_discussions d
      LEFT JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = d.circle_id
      LEFT JOIN public.agents p ON p.id = d.initiated_by_agent_id
      WHERE d.status = 'open'
        AND ${agentId}::uuid = ANY(d.participant_agent_ids)
      ORDER BY d.started_at DESC
      LIMIT ${MAX_ACTIVE_DISCUSSIONS}
    `);
    return coerceRowsList<Row>(rows).map((r): ActiveDiscussionEntry => {
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
        circleId: r.circleId,
        circleName: r.circleName,
        proposerAgentId: r.proposerAgentId,
        proposerAgentName: r.proposerAgentName,
        openObjectionCount: r.openObjectionCount ?? 0,
      };
    });
  }, [], { logger, message: "neighbourhood: active-discussions load failed", context: { agentId } });
}

async function loadTrustSignals(db: Db, agentId: string): Promise<TrustSignalEntry[]> {
  interface Row extends Record<string, unknown> {
    trustedAgentId: string;
    trustedAgentName: string | null;
    skillSlug: string;
    successfulExchanges: number;
    failedExchanges: number;
  }
  return safeLoad(async () => {
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
    return coerceRowsList<Row>(rows).map((r): TrustSignalEntry => ({
      trustedAgentId: r.trustedAgentId,
      trustedAgentName: r.trustedAgentName,
      skillSlug: r.skillSlug,
      successfulExchanges: r.successfulExchanges,
      failedExchanges: r.failedExchanges,
    }));
  }, [], { logger, message: "neighbourhood: trust-signals load failed", context: { agentId } });
}

async function loadMyRoles(db: Db, agentId: string): Promise<MyRoleEntry[]> {
  // The agent's OWN role assignments — every role this agent holds, with the
  // full purpose + accountabilities + domains so the LLM can reason from its
  // own role (not just peers'). Mirrors loadNeighbours() join shape but
  // filters to the calling agent.
  interface Row extends Record<string, unknown> {
    roleId: string;
    roleName: string;
    roleType: string;
    purpose: string | null;
    accountabilities: Array<Record<string, unknown> | string> | null;
    domains: Array<Record<string, unknown> | string> | null;
    circleId: string;
    circleName: string | null;
  }
  return safeLoad(async () => {
    const rows = await db.execute<Row>(sql`
      SELECT
        r.id::text                                                     AS "roleId",
        r.name                                                         AS "roleName",
        r.role_type                                                    AS "roleType",
        r.purpose                                                      AS "purpose",
        COALESCE(r.accountabilities, '[]'::jsonb)                      AS "accountabilities",
        COALESCE(r.domains, '[]'::jsonb)                               AS "domains",
        c.id::text                                                     AS "circleId",
        c.name                                                         AS "circleName"
      FROM plugin_holacracy_c5049b5dfe.role_assignments ra
      JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
      JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
      WHERE ra.agent_id = ${agentId}::uuid
      ORDER BY ra.assigned_at DESC
      LIMIT ${MAX_MY_ROLES}
    `);
    return coerceRowsList<Row>(rows).map((r): MyRoleEntry => ({
      roleId: r.roleId,
      roleName: r.roleName,
      roleType: r.roleType,
      purpose: r.purpose,
      accountabilities: normalizeStringList(r.accountabilities),
      domains: normalizeStringList(r.domains),
      circleId: r.circleId,
      circleName: r.circleName,
    }));
  }, [], { logger, message: "neighbourhood: my-roles lookup failed", context: { agentId } });
}

async function loadCircleStrategies(db: Db, agentId: string): Promise<StrategyEntry[]> {
  // For each circle the agent has a role assignment in, list the top N most
  // recent active strategies. Joined to agents so we can surface the
  // human-readable "set by" name instead of a UUID.
  interface Row extends Record<string, unknown> {
    id: string;
    circleId: string;
    circleName: string | null;
    text: string;
    setBy: string | null;
    setByName: string | null;
    createdAt: string;
    circleRank: number;
  }
  return safeLoad(async () => {
    const rows = await db.execute<Row>(sql`
      WITH my_circles AS (
        SELECT DISTINCT c.id AS circle_id, c.name AS circle_name
        FROM plugin_holacracy_c5049b5dfe.role_assignments ra
        JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
        JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
        WHERE ra.agent_id = ${agentId}::uuid
      ),
      ranked AS (
        SELECT
          s.id,
          s.circle_id,
          s.text,
          s.set_by,
          s.created_at,
          ROW_NUMBER() OVER (PARTITION BY s.circle_id ORDER BY s.created_at DESC) AS rn
        FROM plugin_holacracy_c5049b5dfe.strategies s
        JOIN my_circles mc ON mc.circle_id = s.circle_id
        WHERE s.active = TRUE
      )
      SELECT
        ranked.id::text                AS "id",
        ranked.circle_id::text         AS "circleId",
        mc.circle_name                 AS "circleName",
        ranked.text                    AS "text",
        ranked.set_by::text            AS "setBy",
        a.name                         AS "setByName",
        ranked.created_at::text        AS "createdAt",
        ranked.rn                      AS "circleRank"
      FROM ranked
      JOIN my_circles mc ON mc.circle_id = ranked.circle_id
      LEFT JOIN public.agents a ON a.id = ranked.set_by
      WHERE ranked.rn <= ${MAX_STRATEGIES_PER_CIRCLE}
      ORDER BY ranked.created_at DESC
    `);
    return coerceRowsList<Row>(rows).map((r): StrategyEntry => ({
      id: r.id,
      circleId: r.circleId,
      circleName: r.circleName,
      text: r.text,
      setBy: r.setBy,
      setByName: r.setByName,
      createdAt: r.createdAt,
    }));
  }, [], { logger, message: "neighbourhood: circle-strategies lookup failed", context: { agentId } });
}

async function loadCircleMetrics(db: Db, agentId: string): Promise<MetricEntry[]> {
  // For each circle the agent is in, surface metrics with the latest value
  // (most recent period within the lookback window) and the prior value (the
  // one before that) so the LLM can see a trend. NULL prior_value means
  // either no history or only one report — surfaced as trend=unknown.
  interface Row extends Record<string, unknown> {
    metricId: string;
    metricName: string;
    unit: string | null;
    circleId: string;
    circleName: string | null;
    latestValue: string | number | null;
    latestPeriod: string | null;
    priorValue: string | number | null;
  }
  return safeLoad(async () => {
    const rows = await db.execute<Row>(sql`
      WITH my_circles AS (
        SELECT DISTINCT c.id AS circle_id, c.name AS circle_name
        FROM plugin_holacracy_c5049b5dfe.role_assignments ra
        JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
        JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
        WHERE ra.agent_id = ${agentId}::uuid
      ),
      recent_values AS (
        SELECT
          mv.metric_id,
          mv.value,
          mv.period_date,
          ROW_NUMBER() OVER (PARTITION BY mv.metric_id ORDER BY mv.period_date DESC, mv.created_at DESC) AS rn
        FROM plugin_holacracy_c5049b5dfe.metric_values mv
        WHERE mv.created_at >= NOW() - (${METRIC_LOOKBACK_DAYS}::int * INTERVAL '1 day')
      )
      SELECT
        m.id::text                                          AS "metricId",
        m.name                                              AS "metricName",
        m.unit                                              AS "unit",
        m.circle_id::text                                   AS "circleId",
        mc.circle_name                                      AS "circleName",
        latest.value                                        AS "latestValue",
        latest.period_date::text                            AS "latestPeriod",
        prior.value                                         AS "priorValue"
      FROM plugin_holacracy_c5049b5dfe.metrics m
      JOIN my_circles mc ON mc.circle_id = m.circle_id
      LEFT JOIN recent_values latest ON latest.metric_id = m.id AND latest.rn = 1
      LEFT JOIN recent_values prior ON prior.metric_id = m.id AND prior.rn = 2
      WHERE latest.value IS NOT NULL
      ORDER BY latest.period_date DESC NULLS LAST
      LIMIT ${MAX_METRICS}
    `);
    return coerceRowsList<Row>(rows).map((r): MetricEntry => {
      const latestNum = toNumOrNull(r.latestValue);
      const priorNum = toNumOrNull(r.priorValue);
      let trend: MetricEntry["trend"] = "unknown";
      if (latestNum !== null && priorNum !== null) {
        if (latestNum > priorNum) trend = "up";
        else if (latestNum < priorNum) trend = "down";
        else trend = "flat";
      }
      return {
        metricId: r.metricId,
        metricName: r.metricName,
        unit: r.unit,
        circleId: r.circleId,
        circleName: r.circleName,
        latestValue: latestNum,
        latestPeriod: r.latestPeriod,
        priorValue: priorNum,
        trend,
      };
    });
  }, [], { logger, message: "neighbourhood: circle-metrics lookup failed", context: { agentId } });
}

async function loadCircleChecklists(db: Db, agentId: string): Promise<ChecklistEntry[]> {
  // For each circle the agent is in, surface checklist outcomes from the most
  // recent period within the lookback window: how many responses came back
  // CHECKED vs total responses for that period.
  interface Row extends Record<string, unknown> {
    checklistId: string;
    itemText: string;
    circleId: string;
    circleName: string | null;
    checkedCount: string | number;
    totalCount: string | number;
    latestPeriod: string | null;
  }
  return safeLoad(async () => {
    const rows = await db.execute<Row>(sql`
      WITH my_circles AS (
        SELECT DISTINCT c.id AS circle_id, c.name AS circle_name
        FROM plugin_holacracy_c5049b5dfe.role_assignments ra
        JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
        JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
        WHERE ra.agent_id = ${agentId}::uuid
      ),
      latest_period AS (
        SELECT
          cr.checklist_id,
          MAX(cr.period_date) AS period_date
        FROM plugin_holacracy_c5049b5dfe.checklist_responses cr
        WHERE cr.created_at >= NOW() - (${CHECKLIST_LOOKBACK_DAYS}::int * INTERVAL '1 day')
        GROUP BY cr.checklist_id
      )
      SELECT
        cl.id::text                                                   AS "checklistId",
        cl.item_text                                                  AS "itemText",
        cl.circle_id::text                                            AS "circleId",
        mc.circle_name                                                AS "circleName",
        COUNT(*) FILTER (WHERE cr.checked = TRUE)                     AS "checkedCount",
        COUNT(*)                                                      AS "totalCount",
        lp.period_date::text                                          AS "latestPeriod"
      FROM plugin_holacracy_c5049b5dfe.checklists cl
      JOIN my_circles mc ON mc.circle_id = cl.circle_id
      JOIN latest_period lp ON lp.checklist_id = cl.id
      JOIN plugin_holacracy_c5049b5dfe.checklist_responses cr
        ON cr.checklist_id = cl.id AND cr.period_date = lp.period_date
      GROUP BY cl.id, cl.item_text, cl.circle_id, mc.circle_name, lp.period_date
      ORDER BY lp.period_date DESC NULLS LAST
      LIMIT ${MAX_CHECKLISTS}
    `);
    return coerceRowsList<Row>(rows).map((r): ChecklistEntry => ({
      checklistId: r.checklistId,
      itemText: r.itemText,
      circleId: r.circleId,
      circleName: r.circleName,
      checkedCount: Number(r.checkedCount ?? 0),
      totalCount: Number(r.totalCount ?? 0),
      latestPeriod: r.latestPeriod,
    }));
  }, [], { logger, message: "neighbourhood: circle-checklists lookup failed", context: { agentId } });
}

function normalizeStringList(raw: Array<Record<string, unknown> | string> | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const s = item.trim();
      if (s.length > 0) out.push(s);
      continue;
    }
    if (item && typeof item === "object") {
      const named =
        typeof item.name === "string"
          ? item.name
          : typeof item.text === "string"
            ? item.text
            : typeof item.title === "string"
              ? item.title
              : null;
      if (named && named.trim().length > 0) out.push(named.trim());
    }
  }
  return out;
}

function toNumOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
  for (const mr of snapshot.myRoles) {
    hash.update(`mr:${mr.roleId}:${mr.circleId}\n`);
  }
  for (const s of snapshot.strategies) {
    hash.update(`s:${s.id}:${s.createdAt}\n`);
  }
  for (const m of snapshot.metrics) {
    hash.update(`m:${m.metricId}:${m.latestPeriod ?? ""}:${m.latestValue ?? ""}\n`);
  }
  for (const c of snapshot.checklists) {
    hash.update(`c:${c.checklistId}:${c.latestPeriod ?? ""}:${c.checkedCount}/${c.totalCount}\n`);
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
  const [
    dna,
    neighbours,
    recentPulses,
    unconsumedPerceptions,
    activeDiscussions,
    trustSignals,
    myRoles,
    strategies,
    metrics,
    checklists,
  ] = await Promise.all([
    getCompanyDna(db, companyId).catch((err) => {
      logger.debug({ err, companyId }, "neighbourhood: DNA load failed");
      return null;
    }),
    loadNeighbours(db, agentId),
    loadRecentPulses(db, agentId),
    consumePerceptions(db, agentId),
    loadActiveDiscussions(db, agentId),
    loadTrustSignals(db, agentId),
    loadMyRoles(db, agentId),
    loadCircleStrategies(db, agentId),
    loadCircleMetrics(db, agentId),
    loadCircleChecklists(db, agentId),
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
    myRoles: myRoles.slice(0, MAX_MY_ROLES),
    strategies,
    metrics: metrics.slice(0, MAX_METRICS),
    checklists: checklists.slice(0, MAX_CHECKLISTS),
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
    // T9 (Phase 1.15h-l) — Role→AgentID lookup table so an agent that
    // decides "I'll ask the Lead Link" can find the UUID without parsing
    // prose. Tool calls (talkToAgent / forwardTension) need full UUIDs as
    // `toAgentId` / `targetAgentId` arguments.
    lines.push("**Quick lookup (use these UUIDs as tool arguments):**");
    for (const n of snapshot.neighbours) {
      const roleLabel = n.title ? n.title : n.name;
      lines.push(`- ${n.name} → \`${n.id}\` _(${roleLabel})_`);
    }
    lines.push("");
    lines.push("**Detail:**");
    for (const n of snapshot.neighbours) {
      // T8 (Phase 1.15h-l) — show full UUID, not 8-char prefix. Agents need
      // it as `toAgentId` for talk-to-agent / forward-tension tool calls.
      const circle = n.circleName ? ` [in ${n.circleName} \`${n.circleId}\`]` : "";
      const heartbeat = n.lastHeartbeatAt
        ? ` last-seen=${n.lastHeartbeatAt}`
        : " never-seen";
      lines.push(
        `- **${n.name}** \`${n.id}\`${circle} — ${renderAccountabilities(n.accountabilities)}${heartbeat}`,
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

  // Active discussions you're in (Phase 1.14, with T1+T2 from 1.15h-l —
  // full circleId so agents can `raiseTension`/`broadcast` against the
  // right circle).
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
      const circleLabel = d.circleName ? `${d.circleName} ` : "";
      lines.push(
        `- **${truncate(d.topic, 80)}** [${d.speakerMode}] round ${d.roundsCompleted}/${d.roundsPlanned} phase=${d.phase}${turnFlag}`,
      );
      lines.push(
        `  - Circle: ${circleLabel}\`${d.circleId}\` (use as \`circleId\` arg for tools)`,
      );
      lines.push(
        `  - Discussion: \`${d.id}\` · ContextId: \`${d.contextId}\``,
      );
      // F9 — proposer identity + open-objection count. Proposer line lets every
      // participant know whose tension is being processed (Facilitator stays
      // neutral, Secretary scribes verbatim, Lead Link doesn't synthesize, etc.).
      // Open-objection count tells Facilitator + proposer how much integration
      // work remains in the objections/integration phases.
      if (d.proposerAgentId) {
        const isYou = d.proposerAgentId === snapshot.agentId ? " — **THIS IS YOU**" : "";
        const proposerLabel = d.proposerAgentName ? `${d.proposerAgentName} ` : "";
        lines.push(`  - Proposer: ${proposerLabel}\`${d.proposerAgentId}\`${isYou}`);
      }
      if (d.openObjectionCount > 0) {
        lines.push(
          `  - Open objections / blocks: **${d.openObjectionCount}** (commitments where signal is \`block\` or \`support-with-objection\`)`,
        );
      }
    }
  }
  lines.push("");

  // Phase 1.15h-g2 — agent's OWN role(s) so the LLM can reason from its
  // own purpose + accountabilities, not just peers'.
  if (snapshot.myRoles.length > 0) {
    lines.push("## Your role");
    for (const role of snapshot.myRoles) {
      const circleSuffix = role.circleName ? ` in ${role.circleName}` : "";
      const purpose = role.purpose && role.purpose.trim().length > 0 ? role.purpose.trim() : "_(no purpose recorded)_";
      lines.push(`**${role.roleName}** (${role.roleType}${circleSuffix}) — purpose: ${purpose}`);
      if (role.accountabilities.length > 0) {
        lines.push("");
        lines.push("Accountabilities:");
        for (const a of role.accountabilities.slice(0, MAX_ACCOUNTABILITIES_SHOWN)) {
          lines.push(`- ${a}`);
        }
      }
      if (role.domains.length > 0) {
        lines.push("");
        lines.push(`Domains: ${role.domains.slice(0, MAX_DOMAINS_SHOWN).join(", ")}`);
      }
      lines.push("");
    }
  }

  // Circle strategies — top N most-recent active strategies per circle.
  // T1 (Phase 1.15h-l) — show full circleId/setBy UUIDs so the agent can
  // reference them as tool args.
  if (snapshot.strategies.length > 0) {
    lines.push("## Circle strategies");
    for (const s of snapshot.strategies) {
      const circle = s.circleName ? `${s.circleName} \`${s.circleId}\`` : `\`${s.circleId}\``;
      const setBy = s.setByName ? ` — _${s.setByName}_` : s.setBy ? ` — _\`${s.setBy}\`_` : "";
      lines.push(`- [${circle}] ${truncate(s.text, 200)}${setBy}`);
    }
    lines.push("");
  }

  // Recent circle metrics — latest value with trend vs the prior period.
  if (snapshot.metrics.length > 0) {
    lines.push("## Recent circle metrics");
    for (const m of snapshot.metrics) {
      const circle = m.circleName ? `${m.circleName} \`${m.circleId}\`` : `\`${m.circleId}\``;
      const unit = m.unit ? ` ${m.unit}` : "";
      const value = m.latestValue !== null ? `${m.latestValue}${unit}` : "(no value)";
      const trendStr =
        m.trend === "unknown" || m.priorValue === null
          ? "no prior data"
          : `${m.trend} vs ${m.priorValue}${unit}`;
      lines.push(`- [${circle}] ${m.metricName}: ${value} (${trendStr})`);
    }
    lines.push("");
  }

  // Recent checklist outcomes — checked/total for the most-recent period.
  if (snapshot.checklists.length > 0) {
    lines.push("## Recent checklist outcomes");
    for (const c of snapshot.checklists) {
      const circle = c.circleName ? `${c.circleName} \`${c.circleId}\`` : `\`${c.circleId}\``;
      const period = c.latestPeriod ? ` (period ${c.latestPeriod})` : "";
      lines.push(`- [${circle}] ${truncate(c.itemText, 80)}: ${c.checkedCount}/${c.totalCount}${period}`);
    }
    lines.push("");
  }

  // Trust signals (Phase 1.15f) — who you trust for what.
  lines.push(`### Trust signals (${snapshot.trustSignals.length})`);
  if (snapshot.trustSignals.length === 0) {
    lines.push("_(no trust history yet — every exchange builds the file)_");
  } else {
    for (const t of snapshot.trustSignals) {
      // T8 (Phase 1.15h-l) — show full agent UUID so the agent can use it
      // as `toAgentId` when reaching out to a trusted peer for a skill.
      const name = t.trustedAgentName ?? "agent";
      const ratio = `${t.successfulExchanges}/${t.failedExchanges}`;
      lines.push(`- **${name}** \`${t.trustedAgentId}\` — ${t.skillSlug} (${ratio} successes/failures)`);
    }
  }
  lines.push("");

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}
