CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  domain TEXT,
  defined_by_circle_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL,
  role_id UUID,
  item_text TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.checklist_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL,
  agent_id UUID,
  checked BOOLEAN NOT NULL,
  period_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL,
  role_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.metric_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_id UUID NOT NULL,
  value NUMERIC NOT NULL,
  period_date DATE NOT NULL,
  reported_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL,
  text TEXT NOT NULL,
  set_by UUID,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
