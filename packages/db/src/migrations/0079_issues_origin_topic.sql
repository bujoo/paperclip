-- Phase 1.10 — Multi-dimensional A2A addressing.
--
-- When the runtime bridge materialises an inbound MQTT message as an
-- `issues` row, it records which delivery topic the message landed on. This
-- lets the agent (and auditors) tell *why* the work arrived — personal
-- direct line, circle broadcast, role pool, role broadcast, skill pool, or
-- skill broadcast — without having to re-parse the payload or look up the
-- subscription set.
--
-- Nullable: legacy rows (and any non-A2A origin) leave the column null.

ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS origin_topic text;
CREATE INDEX IF NOT EXISTS issues_origin_topic_idx
  ON public.issues (origin_topic)
  WHERE origin_topic IS NOT NULL;
