-- Migration 008: Integrative Decision-Making (IDM) — canonical Holacracy
-- 6-phase async governance protocol, ridden on top of the existing approvals
-- pipeline (core public.approvals row).
--
-- Phase machine: proposal -> clarifying -> reactions -> amend_or_clarify
--                          -> objections -> integration -> adopted
--                Bypass:   -> dropped
--
-- Notes:
--   * phase / kind are text + app-layer enum (no CREATE TYPE — keeps migration
--     reversible and matches existing convention in 001/003/006/007).
--   * approval_id is a soft pointer to public.approvals(id); we deliberately
--     omit a cross-schema FK to avoid cascade complexity from the core schema.
--   * No CREATE UNIQUE INDEX — the plugin migration validator rejects the
--     "ON" form (see 005). Uniqueness on approval_id is enforced inline.
--   * Deadlines stored as absolute timestamps; the existing 15-min
--     governance-approval-timeout-scanner sweeps phase_deadline_at.

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.idm_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  approval_id uuid NOT NULL,                          -- soft pointer to public.approvals(id)
  circle_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  proposer_agent_id uuid,
  tension_id uuid REFERENCES plugin_holacracy_c5049b5dfe.tensions(id) ON DELETE SET NULL,
  phase text NOT NULL DEFAULT 'proposal',
    -- 'proposal' | 'clarifying' | 'reactions' | 'amend_or_clarify'
    -- | 'objections' | 'integration' | 'adopted' | 'dropped'
  phase_entered_at timestamptz NOT NULL DEFAULT now(),
  phase_deadline_at timestamptz NOT NULL,
  proposal jsonb NOT NULL,                            -- {kind: 'policy'|'agreement'|'role'|..., content: ...}
  amendments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(approval_id)
);

CREATE INDEX IF NOT EXISTS idm_approvals_circle_phase_idx ON plugin_holacracy_c5049b5dfe.idm_approvals (circle_id, phase);
CREATE INDEX IF NOT EXISTS idm_approvals_phase_deadline_idx ON plugin_holacracy_c5049b5dfe.idm_approvals (phase, phase_deadline_at);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.idm_phase_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idm_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.idm_approvals(id) ON DELETE CASCADE,
  phase text NOT NULL,
  agent_id uuid NOT NULL,
  role_id uuid,
  kind text NOT NULL,    -- 'question' | 'reaction' | 'amendment' | 'clarification' | 'objection' | 'integration'
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idm_phase_inputs_idm_phase_idx ON plugin_holacracy_c5049b5dfe.idm_phase_inputs (idm_id, phase);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.idm_objections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idm_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.idm_approvals(id) ON DELETE CASCADE,
  raised_by_agent_id uuid NOT NULL,
  raised_by_role_id uuid,
  body text NOT NULL,
  test_unworkable jsonb,                  -- {result: bool, rationale: string}
  test_follows_from_proposal jsonb,       -- {result: bool, rationale: string}
  test_current_not_speculation jsonb,     -- {result: bool, rationale: string}
  is_valid boolean,                       -- null until all 3 tests filled
  validated_at timestamptz,
  integrated_at timestamptz,
  integration_amendment_id uuid,          -- pointer into idm_phase_inputs (no FK — soft pointer)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idm_objections_idm_idx ON plugin_holacracy_c5049b5dfe.idm_objections (idm_id);
