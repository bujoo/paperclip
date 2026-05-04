CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  parent_circle_id uuid REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE SET NULL,
  name text NOT NULL,
  purpose text,
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  policies jsonb NOT NULL DEFAULT '[]'::jsonb,
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text,
  role_type text NOT NULL DEFAULT 'custom',
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  accountabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.roles(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  focus_ap integer NOT NULL DEFAULT 100,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_id, agent_id)
);

CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.tensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES plugin_holacracy_c5049b5dfe.circles(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  source_agent_id uuid,
  title text NOT NULL,
  description text,
  tension_type text NOT NULL DEFAULT 'operational',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
