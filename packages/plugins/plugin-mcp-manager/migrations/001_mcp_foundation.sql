CREATE TABLE IF NOT EXISTS plugin_mcp_manager_372483a022.mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name text NOT NULL,
  display_name text,
  description text,
  transport_type text NOT NULL DEFAULT 'stdio',
  command text,
  args jsonb NOT NULL DEFAULT '[]',
  env jsonb NOT NULL DEFAULT '{}',
  transport_url text,
  source text NOT NULL DEFAULT 'manual',
  scope text NOT NULL DEFAULT 'company',
  agent_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_mcp_manager_372483a022.agent_mcp_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  mcp_server_id uuid NOT NULL REFERENCES plugin_mcp_manager_372483a022.mcp_servers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
