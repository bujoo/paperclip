import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/**
 * Phase 1.15f — Trust-per-skill signals.
 *
 * Tracks how often `truster_agent` has successfully (vs unsuccessfully)
 * delegated to `trusted_agent` for work tagged with `skill_slug`. Auto-updated
 * by the `holacracy-talk-to-agent` reply hook on TASK_STATE_COMPLETED/FAILED.
 * Surfaced in the neighbourhood snapshot: "Bob — trusted for code-review
 * (12/0); untested for budgeting."
 */
export const agentTrustSignals = pgTable(
  "agent_trust_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trusterAgentId: uuid("truster_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    trustedAgentId: uuid("trusted_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillSlug: text("skill_slug").notNull().default("general"),
    successfulExchanges: integer("successful_exchanges").notNull().default(0),
    failedExchanges: integer("failed_exchanges").notNull().default(0),
    lastExchangeAt: timestamp("last_exchange_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqTriple: unique("agent_trust_signals_unique_triple").on(
      table.trusterAgentId,
      table.trustedAgentId,
      table.skillSlug,
    ),
    trusterIdx: index("agent_trust_signals_truster_idx").on(
      table.trusterAgentId,
      table.lastExchangeAt,
    ),
  }),
);
