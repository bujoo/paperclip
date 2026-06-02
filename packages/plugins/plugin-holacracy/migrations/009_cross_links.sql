-- Migration 009: Cross-links — sibling-circle direct channels (Concept 1).
--
-- A cross-link declares an "operating channel" between two non-ancestral circles
-- (they share a common ancestor but neither is parent of the other). Each side
-- nominates a representative role. Uniqueness on the unordered (circle_a,
-- circle_b) pair is enforced application-side (the plugin migration validator
-- rejects CREATE UNIQUE INDEX with an "ON" clause, see 005).
--
-- Notes:
--   * status text + app-layer enum: 'active' | 'dissolved' (no CREATE TYPE).
--   * rep_role_*_id are ON DELETE RESTRICT — the rep slot must be explicitly
--     vacated before the role can be deleted.

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.circle_cross_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  circle_a_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  circle_b_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  rep_role_a_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.roles(id) ON DELETE RESTRICT,
  rep_role_b_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.roles(id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  created_via_tension_id uuid REFERENCES plugin_holacracy_c5049b5dfe.tensions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  dissolved_at timestamptz,
  dissolved_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (circle_a_id <> circle_b_id)
);

CREATE INDEX IF NOT EXISTS circle_cross_links_company_status_idx ON plugin_holacracy_c5049b5dfe.circle_cross_links (company_id, status);
CREATE INDEX IF NOT EXISTS circle_cross_links_circle_a_idx ON plugin_holacracy_c5049b5dfe.circle_cross_links (circle_a_id);
CREATE INDEX IF NOT EXISTS circle_cross_links_circle_b_idx ON plugin_holacracy_c5049b5dfe.circle_cross_links (circle_b_id);
