-- Domain registry: defines conflicts between roles
CREATE TABLE IF NOT EXISTS plugin_holacracy_c5049b5dfe.domain_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  domain_name text NOT NULL,
  description text,
  conflicting_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, domain_name)
);
