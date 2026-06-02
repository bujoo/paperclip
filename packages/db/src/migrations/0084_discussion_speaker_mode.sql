-- Phase 1.15c — Reverse-priority speaker order + no cross-talk.
--
-- circle_discussions grows three columns:
--   speaker_mode         — 'reverse-priority' (default; Lead Link last), or
--                          'parallel' (Phase 1.14 default; all spawn at once),
--                          or 'roundtable' (alpha), or 'call-out' (explicit).
--   current_speaker_idx  — for reverse-priority/roundtable, the index into the
--                          participants array of the agent currently speaking.
--                          Advanced when that agent's turn issue completes.
--   phase                — 'open' | 'awaiting_commitments' | 'concluded'
--                          Drives the commit-to-support state machine (1.15e).
--   required_commitment_threshold — fraction (0-1) of participants who must
--                          signal `support`/`support-with-objection` for the
--                          discussion to move from `awaiting_commitments`→
--                          `concluded`. Defaults 0.80 (80%).

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS speaker_mode text NOT NULL DEFAULT 'reverse-priority';

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS current_speaker_idx integer NOT NULL DEFAULT 0;

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'open';

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS required_commitment_threshold real NOT NULL DEFAULT 0.8;

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS speaker_order uuid[] NOT NULL DEFAULT '{}'::uuid[];

DO $$ BEGIN
  ALTER TABLE public.circle_discussions
    ADD CONSTRAINT circle_discussions_speaker_mode_check
    CHECK (speaker_mode IN ('reverse-priority', 'roundtable', 'parallel', 'call-out'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.circle_discussions
    ADD CONSTRAINT circle_discussions_phase_check
    CHECK (phase IN ('open', 'awaiting_commitments', 'concluded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Allow circle_id NULL for 1:1 / cross-circle discussions (Phase 1.15g).
ALTER TABLE public.circle_discussions
  ALTER COLUMN circle_id DROP NOT NULL;

-- Commit-to-support signals (Phase 1.15e).
CREATE TABLE IF NOT EXISTS public.discussion_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id uuid NOT NULL REFERENCES public.circle_discussions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  signal text NOT NULL,
  reason text,
  linked_tension_id uuid,
  signaled_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.discussion_commitments
    ADD CONSTRAINT discussion_commitments_signal_check
    CHECK (signal IN ('support', 'support-with-objection', 'block'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.discussion_commitments
    ADD CONSTRAINT discussion_commitments_unique_per_agent
    UNIQUE (discussion_id, agent_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS discussion_commitments_discussion_idx
  ON public.discussion_commitments (discussion_id);
