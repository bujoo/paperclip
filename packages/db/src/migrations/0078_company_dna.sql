-- Phase 1.9 — Company DNA (shared genome layer).
--
-- Adds identity/constitution columns to companies plus the generation
-- counter triple used by the DNA projector to invalidate retained MQTT
-- envelopes. Columns are nullable / defaulted so this migration is safe
-- on existing rows.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS mission_statement text,
  ADD COLUMN IF NOT EXISTS values jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS constitution text,
  ADD COLUMN IF NOT EXISTS dna_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dna_mutated_at timestamptz,
  ADD COLUMN IF NOT EXISTS dna_mutated_reason text;
