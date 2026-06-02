-- Phase 1.15h-i — Grove pre-flight questions on discussions.
--
-- Andy Grove (High Output Management, ch. 5) prescribes six questions for any
-- decision-meeting: what decision, when, who decides, who is consulted, who
-- ratifies/vetoes, who is informed. We already track WHAT (topic) and WHEN
-- (decision_deadline, added in 0086). This migration adds the remaining four
-- WHO columns so the discussion-mode preamble can surface them and so the
-- steward's stuck-discussion healer can call the ratifier directly instead of
-- auto-deadlocking the discussion at 60 minutes.
--
-- All four columns are nullable / default-empty so existing discussions and
-- callers that don't know about Grove's questions keep working unchanged.

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS decision_owner_agent_id uuid,
  ADD COLUMN IF NOT EXISTS consulted_agent_ids uuid[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ratifier_agent_id uuid,
  ADD COLUMN IF NOT EXISTS informed_agent_ids uuid[] DEFAULT '{}';
