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
    /** Phase 1.15c — speaker mode controls turn ordering.
     *  Phase 1.15h-i — Default is `psych_safety` (was `reverse-priority`).
     *  Both values are accepted as aliases by the worker for backwards
     *  compat with existing scripts; `psych_safety` is the honest label —
     *  "Lead Link goes last" is a Grove/psychological-safety overlay, not
     *  Holacracy doctrine (Robertson treats reactions as symmetric). */
    speakerMode: text("speaker_mode").notNull().default("psych_safety"),
    /** Index into speakerOrder for the agent currently speaking. */
    currentSpeakerIdx: integer("current_speaker_idx").notNull().default(0),
    /** Pre-computed speaker order (uuid[]). When non-empty, scheduler uses it
     *  instead of participant_agent_ids for ordering reverse-priority/roundtable. */
    speakerOrder: uuid("speaker_order")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Phase 1.15e — discussion lifecycle phase.
     *  Phase 1.15h-l F1 — Extended to include Robertson IDM's 6 governance
     *  phases so the F3 advancer can transition through them. Drizzle does
     *  not mirror CHECK constraints, so the authoritative allow-list lives
     *  in migration 0090_idm_phases.sql. Allowed values (10):
     *    - 'open'                  — legacy / pre-IDM open state
     *    - 'proposal'              — IDM phase 1: proposer drafts proposal
     *    - 'clarifying_questions'  — IDM phase 2: Q&A, no reactions
     *    - 'reactions'             — IDM phase 3: round-robin reactions
     *    - 'amend'                 — IDM phase 4: proposer may amend
     *    - 'objections'            — IDM phase 5: test objections
     *    - 'integration'           — IDM phase 6: integrate objections
     *    - 'awaiting_commitments'  — post-concl: collect agent commitments
     *    - 'concluded'             — done, conclusion + kind populated
     *    - 'deadlocked'            — stall-healer gave up, escalated */
    phase: text("phase").notNull().default("open"),
    /** Fraction (0..1) of participants who must signal support to conclude. */
    requiredCommitmentThreshold: real("required_commitment_threshold")
      .notNull()
      .default(0.8),
    /** Phase 1.15h-h1 — SMART fields. The discussion-mode preamble surfaces
     *  these so agents know what "done" looks like and converge on a concrete
     *  artifact instead of producing free-form reactions. */
    successCriterion: text("success_criterion"),
    scopeIn: jsonb("scope_in").default(sql`'[]'::jsonb`),
    scopeOut: jsonb("scope_out").default(sql`'[]'::jsonb`),
    decisionDeadline: timestamp("decision_deadline", { withTimezone: true }),
    motivatingTensionId: uuid("motivating_tension_id"),
    /** 'policy' | 'agreement' | 'next_action' | 'role' | 'tension_forward'
     *  | 'metric_change' | 'strategy_update' | 'note'. */
    expectedOutputKind: text("expected_output_kind"),
    /** Phase 1.15h-i #9 — Soft pointer to plugin-holacracy `idm_approvals.id`.
     *  Populated by the worker when a discussion concludes with
     *  `support-with-objection` or `block` signals and the bridge auto-opens
     *  an IDM approval to run those objections through the canonical
     *  6-phase state machine. NULL when no IDM follow-up was needed. */
    idmApprovalId: uuid("idm_approval_id"),
    /** Phase 1.15h-i #2 — Grove pre-flight questions (High Output Management,
     *  ch. 5). For any decision-meeting Grove prescribes: WHAT decides (topic),
     *  WHEN (decision_deadline above), WHO DECIDES (decision_owner_agent_id),
     *  WHO IS CONSULTED (consulted_agent_ids), WHO RATIFIES / VETOES
     *  (ratifier_agent_id — typically Lead Link), WHO IS INFORMED
     *  (informed_agent_ids). All optional; the steward's 60-min stall healer
     *  calls the ratifier when known instead of auto-deadlocking. */
    decisionOwnerAgentId: uuid("decision_owner_agent_id"),
    consultedAgentIds: uuid("consulted_agent_ids")
      .array()
      .default(sql`'{}'::uuid[]`),
    ratifierAgentId: uuid("ratifier_agent_id"),
    informedAgentIds: uuid("informed_agent_ids")
      .array()
      .default(sql`'{}'::uuid[]`),
    /** Phase 1.15h-l F3 — Count of times the IDM phase advancer has cycled
     *  through integration → objections for this discussion. Bounded by
     *  MAX_INTEGRATION_CYCLES (worker.ts, currently 3) before the advancer
     *  force-promotes the discussion to `awaiting_commitments` to prevent
     *  an infinite objection-integration ping-pong. */
    integrationCyclesCount: integer("integration_cycles_count")
      .notNull()
      .default(0),
  },
  (table) => ({
    circleStatusIdx: index("circle_discussions_circle_status_idx").on(
      table.circleId,
      table.status,
    ),
    contextIdx: index("circle_discussions_context_idx").on(table.a2aContextId),
  }),
);
