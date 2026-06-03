/**
 * @fileoverview Helper for the `public.agent_trust_signals` UPSERT.
 *
 * Mirrors the canonical UPSERT shape used in
 * `packages/plugins/plugin-holacracy/src/worker.ts:~2150` (function
 * `updateTrustSignal`). The plugin worker has its own scoped DB context
 * (`dbCtx`) so it can't share the *function* directly — but the SQL is
 * identical. If you change the schema for `agent_trust_signals`, update
 * both copies.
 *
 * @module server/services/trust-signals
 */

import { sql, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Increment a trust signal between two agents on a skill slug.
 * Idempotent UPSERT on `(truster_agent_id, trusted_agent_id, skill_slug)`.
 *
 * `successful=true` increments `successful_exchanges`;
 * `successful=false` increments `failed_exchanges`.
 *
 * Best-effort — swallows + logs any DB error so the caller's hot path
 * (a publish + reply correlation) is never blocked by a trust-write
 * failure.
 */
export async function upsertTrustSignal(
  db: Db,
  trusterAgentId: string,
  trustedAgentId: string,
  skillSlug: string,
  successful: boolean,
): Promise<void> {
  if (!trusterAgentId || !trustedAgentId) return;
  if (trusterAgentId === trustedAgentId) return; // don't trust-rate yourself
  try {
    await db.execute(sql`
      INSERT INTO public.agent_trust_signals
        (truster_agent_id, trusted_agent_id, skill_slug, successful_exchanges, failed_exchanges, last_exchange_at)
      VALUES (${trusterAgentId}::uuid, ${trustedAgentId}::uuid, ${skillSlug}, ${successful ? 1 : 0}, ${successful ? 0 : 1}, NOW())
      ON CONFLICT (truster_agent_id, trusted_agent_id, skill_slug) DO UPDATE
        SET successful_exchanges = public.agent_trust_signals.successful_exchanges + EXCLUDED.successful_exchanges,
            failed_exchanges     = public.agent_trust_signals.failed_exchanges    + EXCLUDED.failed_exchanges,
            last_exchange_at     = NOW(),
            updated_at           = NOW()
    `);
  } catch (err) {
    logger.debug(
      { err, trusterAgentId, trustedAgentId, skillSlug, successful },
      "trust-signals: UPSERT failed (best-effort)",
    );
  }
}
