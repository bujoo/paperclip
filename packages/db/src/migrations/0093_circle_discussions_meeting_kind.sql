-- G4 (Phase 1.20) — meeting_kind on circle_discussions.
--
-- Robertson's constitution is strict about tactical vs governance meeting
-- separation. The two have different objection criteria, different
-- facilitator powers, and different output artifacts (next-actions vs
-- policy). Mixing them degrades output (ChatDev phase-bleed ablation
-- shows ~15-20% quality drop on phase-bleed in multi-agent systems).
--
-- Add a meeting_kind column to circle_discussions; the worker's
-- raise-tension path refuses a governance-type tension when the active
-- discussion has meeting_kind='tactical', returning a redirect pointer
-- to the next governance meeting instead of silently auto-queueing.
--
-- NULL preserves existing rows (no gate enforcement on legacy discussions).
-- Only newly-created discussions that explicitly set meeting_kind get gated.

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS meeting_kind text NULL;

ALTER TABLE public.circle_discussions
  ADD CONSTRAINT circle_discussions_meeting_kind_check
  CHECK (meeting_kind IS NULL OR meeting_kind IN ('tactical', 'governance', 'adhoc'));

CREATE INDEX IF NOT EXISTS circle_discussions_meeting_kind_idx
  ON public.circle_discussions (meeting_kind)
  WHERE meeting_kind IS NOT NULL;

COMMENT ON COLUMN public.circle_discussions.meeting_kind IS
  'Phase 1.20 G4 — tactical|governance|adhoc. NULL = legacy/ungated. Governance tensions refused inside tactical discussions per Robertson constitution.';
