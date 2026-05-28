ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "accountabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
