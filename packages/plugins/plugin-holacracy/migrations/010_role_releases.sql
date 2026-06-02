-- Migration 010: Role-release lifecycle (Concept 3 — right of refusal).
--
-- A role assignee can request release; the parent Lead Link must accept;
-- handoff then completes by either re-assigning the role to a new agent or
-- vacating it. release_state on the role_assignments row mirrors the live
-- state-machine; role_releases captures every cycle as an auditable record.
--
-- Notes:
--   * release_state / status are text + app-layer enum (no CREATE TYPE).
--   * No CREATE UNIQUE INDEX — open-release uniqueness is enforced in handler.

ALTER TABLE plugin_holacracy_c5049b5dfe.role_assignments
  ADD COLUMN IF NOT EXISTS release_state text NOT NULL DEFAULT 'active';
  -- 'active' | 'release_requested' | 'release_pending_handoff' | 'released'

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.role_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  role_assignment_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.role_assignments(id) ON DELETE CASCADE,
  released_by_agent_id uuid NOT NULL,
  handoff_to_agent_id uuid,
  handoff_notes text,
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_by_lead_link_at timestamptz,
  accepted_by_lead_link_agent_id uuid,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'requested'
    -- 'requested' | 'pending_handoff' | 'completed' | 'cancelled'
);

CREATE INDEX IF NOT EXISTS role_releases_company_status_idx ON plugin_holacracy_c5049b5dfe.role_releases (company_id, status);
CREATE INDEX IF NOT EXISTS role_releases_assignment_idx ON plugin_holacracy_c5049b5dfe.role_releases (role_assignment_id);
