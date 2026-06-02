-- Phase 1.15h-l F1 — Add IDM 6-phase values to circle_discussions.phase
--
-- Migration 0084 created `circle_discussions_phase_check` restricting `phase`
-- to ('open', 'awaiting_commitments', 'concluded'). The advancer code-path
-- also writes 'deadlocked' (stall-healer outcome). Robertson's IDM defines
-- six governance phases that the F3 advancer needs to walk through:
--
--   proposal → clarifying_questions → reactions → amend → objections → integration
--
-- Drop the existing CHECK and recreate it with the full union of the legacy
-- 4 values + the 6 IDM phases (10 total). DROP IF EXISTS makes the migration
-- idempotent when re-applied against an instance where the constraint name
-- happens to differ — but the constraint was named by 0084, so it should
-- exist under the canonical name.

ALTER TABLE public.circle_discussions
  DROP CONSTRAINT IF EXISTS circle_discussions_phase_check;

DO $$ BEGIN
  ALTER TABLE public.circle_discussions
    ADD CONSTRAINT circle_discussions_phase_check
    CHECK (phase IN (
      'open',
      'proposal',
      'clarifying_questions',
      'reactions',
      'amend',
      'objections',
      'integration',
      'awaiting_commitments',
      'concluded',
      'deadlocked'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
