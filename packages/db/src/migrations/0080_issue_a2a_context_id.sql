-- Phase 1.13 — Multi-turn A2A conversation threading via `Task.context_id`.
--
-- When an A2A inbound Task carries a `context_id`, the inbound handler now
-- persists it on the materialised issue so the bridge reply hook (and the
-- new `holacracy-talk-to-agent` / `holacracy-reply-on-task` tools) can echo
-- the same context across multiple round-trips. If the incoming Task has no
-- `context_id`, the handler mints a fresh UUID — every issue that originated
-- from an A2A request therefore has a stable conversation thread id.
--
-- Nullable: legacy rows + any non-A2A origin leave the column null.

ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS a2a_context_id text;
CREATE INDEX IF NOT EXISTS issues_a2a_context_id_idx
  ON public.issues (a2a_context_id)
  WHERE a2a_context_id IS NOT NULL;
