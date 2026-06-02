import { pgTable, uuid, text, jsonb, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Phase 1.14 — Circle Discussions.
 *
 * A discussion is a multi-agent conversation thread on a circle. The plugin-
 * holacracy worker spawns one issue per participant per round (each sharing
 * the same `a2a_context_id`); when all of a round's issues are `done`, the
 * scheduler either spawns the next round (with a digest of prior rounds in
 * the description) or asks the circle's Secretary to summarise. The summary
 * payload is parsed back into `conclusion` + `conclusion_kind` and the
 * discussion is marked `concluded`.
 *
 * The table lives in `public` (not the holacracy plugin schema) because it
 * references public.companies + public.agents. `circle_id` is logically a
 * FK to plugin-holacracy's circles table but is not declared cross-schema —
 * the plugin namespace name is install-dependent.
 */
export const circleDiscussions = pgTable(
  "circle_discussions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Nullable for 1:1 / cross-circle discussions (Phase 1.15g). */
    circleId: uuid("circle_id"),
    a2aContextId: text("a2a_context_id").notNull(),
    topic: text("topic").notNull(),
    promptForAgents: text("prompt_for_agents"),
    initiatedByAgentId: uuid("initiated_by_agent_id").references(() => agents.id),
    initiatedByUserId: text("initiated_by_user_id"),
    /** uuid[] — pinned at start from circle membership. */
    participantAgentIds: uuid("participant_agent_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** 'open' | 'concluded' | 'cancelled'. */
    status: text("status").notNull().default("open"),
    roundsPlanned: integer("rounds_planned").notNull().default(1),
    roundsCompleted: integer("rounds_completed").notNull().default(0),
    conclusion: text("conclusion"),
    /** 'agreement' | 'policy' | 'tension' | 'next-action' | 'note' | null. */
    conclusionKind: text("conclusion_kind"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    concludedAt: timestamp("concluded_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    /** Phase 1.15c — speaker mode controls turn ordering. */
    speakerMode: text("speaker_mode").notNull().default("reverse-priority"),
    /** Index into speakerOrder for the agent currently speaking. */
    currentSpeakerIdx: integer("current_speaker_idx").notNull().default(0),
    /** Pre-computed speaker order (uuid[]). When non-empty, scheduler uses it
     *  instead of participant_agent_ids for ordering reverse-priority/roundtable. */
    speakerOrder: uuid("speaker_order")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Phase 1.15e — 'open' | 'awaiting_commitments' | 'concluded'. */
    phase: text("phase").notNull().default("open"),
    /** Fraction (0..1) of participants who must signal support to conclude. */
    requiredCommitmentThreshold: real("required_commitment_threshold")
      .notNull()
      .default(0.8),
  },
  (table) => ({
    circleStatusIdx: index("circle_discussions_circle_status_idx").on(
      table.circleId,
      table.status,
    ),
    contextIdx: index("circle_discussions_context_idx").on(table.a2aContextId),
  }),
);
