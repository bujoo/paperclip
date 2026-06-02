CREATE TABLE IF NOT EXISTS "a2a_pending_replies" (
  "issue_id" uuid PRIMARY KEY REFERENCES "issues"("id") ON DELETE CASCADE,
  "task_id" text NOT NULL,
  "response_topic" text NOT NULL,
  "correlation_data" bytea,
  "user_properties" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "a2a_pending_replies_task_idx" ON "a2a_pending_replies" ("task_id");
