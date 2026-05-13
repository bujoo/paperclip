CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  agent_id UUID,
  role_id UUID,
  circle_id UUID,
  action_type TEXT NOT NULL,
  action_detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
