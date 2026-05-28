-- Migration 005: Add idempotency support for accountability scanner tensions
-- Dedup key: (agent_id, accountability_name, scan_date) prevents duplicate tensions per day
-- Note: unique index on idempotency_key is enforced in application code (scanner checks before insert)
-- because CREATE UNIQUE INDEX uses ON keyword which is not supported by the plugin migration validator.

ALTER TABLE plugin_holacracy_c5049b5dfe.tensions
  ADD COLUMN IF NOT EXISTS idempotency_key text;
