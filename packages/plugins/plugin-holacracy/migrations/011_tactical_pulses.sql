-- Migration 011: Tactical pulse + cross-role requests (Concept 6).
--
-- tactical_records — per-circle snapshot of tactical state (open tensions,
-- assignment load, etc). Pulses are scheduled or ad-hoc; the JSON summary
-- evolves over time.
--
-- cross_role_requests — durable record of every "request from role" event.
-- For next_action / project kinds the worker also creates a paired issue; the
-- issue_id pointer survives even if the issue is later deleted (SET NULL).
--
-- Notes:
--   * No CREATE TYPE (status/kind text + app-layer enum).
--   * No CREATE UNIQUE INDEX — uniqueness not required for these tables.

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.tactical_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  circle_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  cadence text NOT NULL DEFAULT 'ad_hoc',
  summary jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tactical_records_circle_idx ON plugin_holacracy_c5049b5dfe.tactical_records (circle_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.cross_role_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  requesting_role_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.roles(id) ON DELETE CASCADE,
  target_role_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.roles(id) ON DELETE CASCADE,
  kind text NOT NULL,             -- 'next_action' | 'project' | 'info'
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'declined'
  issue_id uuid,                  -- soft pointer to core public.issues(id) (no FK)
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS cross_role_requests_target_idx ON plugin_holacracy_c5049b5dfe.cross_role_requests (target_role_id, status);
CREATE INDEX IF NOT EXISTS cross_role_requests_requesting_idx ON plugin_holacracy_c5049b5dfe.cross_role_requests (requesting_role_id);
