import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { circleDiscussions } from "./circle-discussions.js";

/**
 * Phase 1.15e — Per-participant commit-to-support signals on a discussion.
 *
 *   support                 — bind to the conclusion
 *   support-with-objection  — bind + auto-create a linked tension (principle #11)
 *   block                   — only Lead Link / Secretary / Facilitator / domain
 *                             owner can block; others' blocks auto-downgrade
 *                             to support-with-objection in worker logic.
 */
export const discussionCommitments = pgTable(
  "discussion_commitments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => circleDiscussions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    signal: text("signal").notNull(),
    reason: text("reason"),
    linkedTensionId: uuid("linked_tension_id"),
    signaledAt: timestamp("signaled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePerAgent: unique("discussion_commitments_unique_per_agent").on(
      table.discussionId,
      table.agentId,
    ),
    discussionIdx: index("discussion_commitments_discussion_idx").on(table.discussionId),
  }),
);
