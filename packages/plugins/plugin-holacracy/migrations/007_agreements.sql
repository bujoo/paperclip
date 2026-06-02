-- Migration 007: Agreements (afspraken) — third Holacracy governance output.
-- Distinct from policies (rules) and elections (assignments). Captures explicit
-- "If Y then I commit to X" contracts between roles, both intra-circle and
-- cross-circle. Status flow: proposed -> active -> (expired|revoked).
--
-- Notes:
--   * scope/status are text + app-layer enum (no CREATE TYPE — keeps migration
--     reversible and matches existing convention in 001/003/006).
--   * approval_id is a soft pointer to public.approvals(id); we deliberately
--     omit a cross-schema FK to avoid cascade complexity from the core schema.
--   * No CREATE UNIQUE INDEX — the plugin migration validator rejects the
--     "ON" keyword form (see 005_accountability_scanner.sql). Uniqueness
--     is not required for this slice.

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  scope text NOT NULL,                        -- 'intra_circle' | 'cross_circle'
  primary_circle_id uuid REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  parties jsonb NOT NULL,                     -- [{role_id, circle_id}, ...]
  title text NOT NULL,
  condition text,                             -- "Y" trigger condition
  commitment text NOT NULL,                   -- "X" commitment
  status text NOT NULL DEFAULT 'proposed',    -- 'proposed' | 'active' | 'expired' | 'revoked'
  activated_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  proposed_via_tension_id uuid REFERENCES plugin_holacracy_c5049b5dfe.tensions(id) ON DELETE SET NULL,
  approval_id uuid,                           -- soft pointer to core public.approvals(id)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agreements_company_status_idx ON plugin_holacracy_c5049b5dfe.agreements (company_id, status);
CREATE INDEX IF NOT EXISTS agreements_primary_circle_idx ON plugin_holacracy_c5049b5dfe.agreements (primary_circle_id);
