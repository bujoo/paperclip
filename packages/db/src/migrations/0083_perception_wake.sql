-- Phase 1.15b — Wake-on-discussion-turn.
--
-- agent_perceptions get two new columns:
--   wake_eligible      — flag set true by the inbound handler when the topic
--                        is a discussion topic (paperclip/v1/discussion/{c}/+),
--                        causing the heartbeat scheduler to enqueue a wakeup.
--   wake_processed_at  — stamped by the scheduler after a wakeup is enqueued,
--                        so we don't re-enqueue the same perception.
--
-- The composite index (agent_id, wake_eligible, wake_processed_at) lets the
-- per-tick "find unprocessed wake-eligible perceptions for this agent" query
-- hit a single index.

ALTER TABLE public.agent_perceptions
  ADD COLUMN IF NOT EXISTS wake_eligible boolean NOT NULL DEFAULT false;

ALTER TABLE public.agent_perceptions
  ADD COLUMN IF NOT EXISTS wake_processed_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_perceptions_wake_idx
  ON public.agent_perceptions (agent_id, wake_eligible, wake_processed_at);
