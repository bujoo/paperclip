-- Holacracy circles: self-governing organizational units
CREATE TABLE holacracy.circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  parent_circle_id uuid REFERENCES holacracy.circles(id) ON DELETE SET NULL,
  name text NOT NULL,
  purpose text,
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  policies jsonb NOT NULL DEFAULT '[]'::jsonb,
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_circles_company ON holacracy.circles(company_id);
CREATE INDEX idx_circles_parent ON holacracy.circles(parent_circle_id);

-- Holacracy roles: defined containers for work within a circle
CREATE TABLE holacracy.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES holacracy.circles(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text,
  role_type text NOT NULL DEFAULT 'custom',
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  accountabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_roles_circle ON holacracy.roles(circle_id);

-- Role assignments: which agent fills which role
CREATE TABLE holacracy.role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES holacracy.roles(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  focus_ap integer NOT NULL DEFAULT 100,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_id, agent_id)
);

CREATE INDEX idx_assignments_role ON holacracy.role_assignments(role_id);
CREATE INDEX idx_assignments_agent ON holacracy.role_assignments(agent_id);

-- Tensions: gaps between current reality and potential
CREATE TABLE holacracy.tensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES holacracy.circles(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  source_agent_id uuid,
  title text NOT NULL,
  description text,
  tension_type text NOT NULL DEFAULT 'operational',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX idx_tensions_circle ON holacracy.tensions(circle_id);
CREATE INDEX idx_tensions_status ON holacracy.tensions(status);
