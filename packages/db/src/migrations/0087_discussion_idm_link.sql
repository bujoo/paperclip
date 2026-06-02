-- Phase 1.15h-i #9 — Bridge circle_discussions to idm_approvals.
--
-- When a discussion finishes its summariser phase with any
-- `support-with-objection` or `block` commitment signals, the holacracy
-- worker now auto-opens an IDM approval seeded with those objections (see
-- `bridgeDiscussionToIdm` in worker.ts). Per Robertson, an objection without
-- integration is illegitimate, so the existing 6-phase IDM state machine must
-- run on the discussion's outcome.
--
-- This column is a soft pointer (no cross-schema FK — the plugin namespace
-- name is install-dependent, same convention as the rest of this table) into
-- the plugin-holacracy `idm_approvals` table. UI uses it to render a "→ IDM"
-- link on the discussion's concluded lifecycle event.

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS idm_approval_id uuid;

CREATE INDEX IF NOT EXISTS circle_discussions_idm_approval_idx
  ON public.circle_discussions (idm_approval_id)
  WHERE idm_approval_id IS NOT NULL;
