CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.workflows(id) ON DELETE CASCADE,
  step_number INT NOT NULL,
  role_name TEXT NOT NULL,
  title TEXT NOT NULL,
  inputs TEXT[] NOT NULL DEFAULT '{}',
  outputs TEXT[] NOT NULL DEFAULT '{}',
  sla_days INT NOT NULL DEFAULT 1,
  blocks_next_step BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (workflow_id, step_number)
);
