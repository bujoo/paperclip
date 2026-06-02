-- Phase 1.15h-h1 — SMART discussion schema.
--
-- Adds Specific / Measurable / Achievable / Relevant / Time-bound fields to
-- circle_discussions so each discussion has a clear success criterion,
-- explicit in/out scope, a decision deadline, an optional motivating tension
-- pointer, and an expected output artifact kind. The discussion-mode
-- preamble surfaces these to agents so they know how to converge instead of
-- producing free-text reactions indefinitely.

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS success_criterion text,
  ADD COLUMN IF NOT EXISTS scope_in jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scope_out jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS decision_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS motivating_tension_id uuid,
  ADD COLUMN IF NOT EXISTS expected_output_kind text;
