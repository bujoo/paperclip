ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'next_action';
CREATE INDEX IF NOT EXISTS "issues_company_kind_idx" ON "issues" USING btree ("company_id","kind");
