/**
 * @fileoverview Trust-thresholded skill awareness (Phase 1.19 T4).
 *
 * Computes a per-agent, per-skill trust score in [0.1, 0.95] that combines:
 *
 *  1. **Cold-start baseline** — newly-created agents default to 0.5 (no
 *     history doesn't mean "untrusted"; it means "unknown"). A 14-day
 *     "grace" window flags the agent so callers can soften failure costs.
 *  2. **Endorsements** — peers already trusted on this skill (trust >=
 *     `ENDORSER_MIN_TRUST`) can lift a peer's floor to `ENDORSEMENT_BOOST_TO`
 *     via a row in `public.feedback_votes` with
 *     `target_type='agent_skill_endorsement'`.
 *  3. **History** — aggregated successful/failed exchange counts from
 *     `public.agent_trust_signals` (summed across all trusters for this
 *     `(trusted_agent, skill_slug)` pair). Posterior is a Bayesian
 *     Beta(1,1) update: `(successful + 1) / (successful + failed + 2)`.
 *  4. **Decay** — old wins shouldn't trust an agent forever; multiply by
 *     `exp(-daysSinceLastExchange / 90)` so trust half-lives in ~63 days.
 *  5. **Bounds** — final clamp to `[0.1, 0.95]` so nothing is ever
 *     "perfectly trusted" or "completely untrusted".
 *
 * The `agentTrustScore()` helper is the canonical reader. T4's decline and
 * endorsement endpoints call it; future routing or planner code should too
 * so the formula has a single home.
 *
 * @module server/services/trust-score
 */

import { sql, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const TRUST_THRESHOLD = 0.7;
export const COLD_START_BASELINE = 0.5;
export const ENDORSEMENT_BOOST_TO = 0.65;
export const ENDORSER_MIN_TRUST = 0.85;
export const GRACE_DAYS = 14;
/** Decay coefficient: trust *= exp(-days / 90) ⇒ ~63d half-life. */
export const DECAY_TIME_CONSTANT_DAYS = 90;
export const DECAY_HALF_LIFE_DAYS = 63;
const SCORE_FLOOR = 0.1;
const SCORE_CEIL = 0.95;

export interface TrustScoreResult {
  score: number;
  isInGrace: boolean;
  graceDaysRemaining: number;
  endorsedBy: string[];
  basedOn: "cold-start" | "endorsement" | "history";
  successfulExchanges: number;
  failedExchanges: number;
}

interface AgentRow extends Record<string, unknown> {
  createdAt: Date | null;
}

interface HistoryRow extends Record<string, unknown> {
  successful_exchanges: string | number | null;
  failed_exchanges: string | number | null;
  last_exchange_at: Date | string | null;
}

interface EndorsementRow extends Record<string, unknown> {
  author_user_id: string | null;
}

function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function asNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Decode an endorsement row's author. We store the endorser agent id in
 * `author_user_id` with the synthetic prefix `agent:` because
 * `feedback_votes.author_user_id` is `text NOT NULL` and the table has no
 * dedicated `author_agent_id` column. Returns null for legacy/malformed rows.
 */
function decodeEndorsementAuthor(authorUserId: string | null): string | null {
  if (!authorUserId) return null;
  return authorUserId.startsWith("agent:") ? authorUserId.slice("agent:".length) : null;
}

/**
 * Encode an agent endorser id into the `author_user_id` text column. See
 * decode pair above. Kept here so both sides stay in sync.
 */
export function encodeEndorsementAuthor(agentId: string): string {
  return `agent:${agentId}`;
}

export const ENDORSEMENT_TARGET_TYPE = "agent_skill_endorsement" as const;
export const ENDORSEMENT_VOTE = "endorsed" as const;

/** `<agentId>:<skillSlug>` — the conventional target_id for endorsements. */
export function endorsementTargetId(agentId: string, skillSlug: string): string {
  return `${agentId}:${skillSlug}`;
}

/**
 * Compute the trust score for `agentId` on `skillSlug`. Best-effort: on
 * a DB error we degrade to a permissive cold-start score (0.5) rather
 * than blocking the caller.
 */
export async function agentTrustScore(
  db: Db,
  agentId: string,
  skillSlug: string,
): Promise<TrustScoreResult> {
  const targetId = endorsementTargetId(agentId, skillSlug);

  // ── 1. Agent creation timestamp for grace-window math ────────────────
  let createdAt: Date | null = null;
  try {
    const rows = await db.execute<AgentRow>(sql`
      SELECT created_at AS "createdAt"
        FROM public.agents
       WHERE id = ${agentId}::uuid
       LIMIT 1
    `);
    const first = toRows<AgentRow>(rows)[0];
    if (first?.createdAt) {
      createdAt = first.createdAt instanceof Date ? first.createdAt : new Date(first.createdAt as unknown as string);
    }
  } catch (err) {
    logger.debug({ err, agentId }, "trust-score: agent lookup failed (best-effort)");
  }

  const now = Date.now();
  const ageMs = createdAt ? now - createdAt.getTime() : Number.POSITIVE_INFINITY;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const isInGrace = Number.isFinite(ageDays) ? ageDays < GRACE_DAYS : false;
  const graceDaysRemaining = isInGrace ? Math.max(0, GRACE_DAYS - ageDays) : 0;

  // ── 2. Aggregated history from agent_trust_signals ───────────────────
  let successful = 0;
  let failed = 0;
  let lastExchangeAt: Date | null = null;
  try {
    const rows = await db.execute<HistoryRow>(sql`
      SELECT COALESCE(SUM(successful_exchanges), 0)::bigint AS successful_exchanges,
             COALESCE(SUM(failed_exchanges), 0)::bigint     AS failed_exchanges,
             MAX(last_exchange_at)                          AS last_exchange_at
        FROM public.agent_trust_signals
       WHERE trusted_agent_id = ${agentId}::uuid
         AND skill_slug = ${skillSlug}
    `);
    const first = toRows<HistoryRow>(rows)[0];
    if (first) {
      successful = asNumber(first.successful_exchanges);
      failed = asNumber(first.failed_exchanges);
      const last = first.last_exchange_at;
      if (last) lastExchangeAt = last instanceof Date ? last : new Date(last);
    }
  } catch (err) {
    logger.debug({ err, agentId, skillSlug }, "trust-score: history lookup failed (best-effort)");
  }

  // ── 3. Endorsements from feedback_votes ──────────────────────────────
  const endorsedBy: string[] = [];
  try {
    const rows = await db.execute<EndorsementRow>(sql`
      SELECT author_user_id
        FROM public.feedback_votes
       WHERE target_type = ${ENDORSEMENT_TARGET_TYPE}
         AND target_id   = ${targetId}
         AND vote        = ${ENDORSEMENT_VOTE}
    `);
    for (const row of toRows<EndorsementRow>(rows)) {
      const decoded = decodeEndorsementAuthor(row.author_user_id);
      if (decoded) endorsedBy.push(decoded);
    }
  } catch (err) {
    logger.debug({ err, agentId, skillSlug }, "trust-score: endorsement lookup failed (best-effort)");
  }

  // ── 4. Combine signals ───────────────────────────────────────────────
  const totalExchanges = successful + failed;
  let basedOn: TrustScoreResult["basedOn"];
  let raw: number;

  if (totalExchanges > 0) {
    // Bayesian Beta(1,1) posterior — cold-start prior (no data) = 0.5.
    raw = (successful + 1) / (successful + failed + 2);
    basedOn = "history";
    // If endorsed, the endorsement raises the *floor*, not the cap.
    if (endorsedBy.length > 0 && raw < ENDORSEMENT_BOOST_TO) {
      raw = ENDORSEMENT_BOOST_TO;
      basedOn = "endorsement";
    }
  } else if (endorsedBy.length > 0) {
    raw = Math.max(COLD_START_BASELINE, ENDORSEMENT_BOOST_TO);
    basedOn = "endorsement";
  } else {
    raw = COLD_START_BASELINE;
    basedOn = "cold-start";
  }

  // ── 5. Time decay (only when we have a real history signal) ──────────
  if (lastExchangeAt) {
    const daysSince = Math.max(0, (now - lastExchangeAt.getTime()) / (1000 * 60 * 60 * 24));
    const decay = Math.exp(-daysSince / DECAY_TIME_CONSTANT_DAYS);
    raw *= decay;
  }

  const score = Math.min(SCORE_CEIL, Math.max(SCORE_FLOOR, raw));

  return {
    score,
    isInGrace,
    graceDaysRemaining,
    endorsedBy,
    basedOn,
    successfulExchanges: successful,
    failedExchanges: failed,
  };
}
