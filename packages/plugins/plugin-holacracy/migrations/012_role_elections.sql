-- Migration 012: Capability-based role elections (Concept 8).
--
-- An election scores every candidate agent against a target role using two
-- factors:
--   capability_score = Jaccard(agent.accountabilities, role.accountabilities)
--   load_score       = max(0, 1.0 - sum(focus_ap)/100)
--   composite_score  = 0.7 * capability + 0.3 * load
--
-- rationale captures matchedAccountabilities + gaps + domain-registry conflicts
-- as JSON for explainability and audit.
--
-- Notes:
--   * status text + app-layer enum (no CREATE TYPE).
--   * No CREATE UNIQUE INDEX (validator constraint).

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.role_election_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  circle_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  target_role_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.roles(id) ON DELETE CASCADE,
  requested_by_agent_id uuid,
  status text NOT NULL DEFAULT 'open',
    -- 'open' | 'scoring' | 'scored' | 'decided' | 'cancelled'
  decision_agent_id uuid,
  decided_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_election_requests_circle_status_idx ON plugin_holacracy_c5049b5dfe.role_election_requests (circle_id, status);
CREATE INDEX IF NOT EXISTS role_election_requests_target_role_idx ON plugin_holacracy_c5049b5dfe.role_election_requests (target_role_id);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.role_election_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.role_election_requests(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  capability_score double precision NOT NULL,
  load_score double precision NOT NULL,
  composite_score double precision NOT NULL,
  rationale jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_election_candidates_election_idx ON plugin_holacracy_c5049b5dfe.role_election_candidates (election_id, composite_score DESC);
