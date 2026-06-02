-- Phase 1.15h-i — Relabel `reverse-priority` speaker_mode as `psych_safety`.
--
-- The "Lead Link goes last" turn-ordering is not Holacracy doctrine —
-- Robertson treats reactions in IDM as symmetric. It IS a useful Grove/
-- psychological-safety overlay (give the highest-status voice last so it
-- doesn't anchor the discussion) but it's a team-practice overlay, not
-- Holacracy. This migration relabels existing rows so the database matches
-- the new vocabulary surfaced in the UI.
--
-- Migration 0084 added a CHECK constraint restricting speaker_mode to
-- ('reverse-priority', 'roundtable', 'parallel', 'call-out'). We must
-- replace it BEFORE the UPDATE so the new label is accepted. The new
-- constraint accepts BOTH 'reverse-priority' and 'psych_safety' as the
-- same behaviour (the worker normalises one to the other on write).

ALTER TABLE public.circle_discussions
  DROP CONSTRAINT IF EXISTS circle_discussions_speaker_mode_check;

DO $$ BEGIN
  ALTER TABLE public.circle_discussions
    ADD CONSTRAINT circle_discussions_speaker_mode_check
    CHECK (speaker_mode IN (
      'psych_safety',
      'reverse-priority',
      'roundtable',
      'parallel',
      'call-out'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE public.circle_discussions
   SET speaker_mode = 'psych_safety'
 WHERE speaker_mode = 'reverse-priority';
