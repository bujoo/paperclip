-- Phase 1.15h-l F3 — Integration cycle counter for IDM phase advancer.
--
-- The IDM advancer (plugin-holacracy worker `advanceOneRound`) walks
-- circle_discussions through Robertson's 6 phases. The `integration` ⇄
-- `objections` loop can theoretically run forever if each integration
-- amendment surfaces new objections. To bound runtime we count how many
-- times a given discussion has cycled through integration and force-promote
-- to `awaiting_commitments` once it crosses a threshold (currently 3, in
-- worker.ts: MAX_INTEGRATION_CYCLES).
--
-- Default 0; existing rows start at 0 with no behavioural change. The
-- column is plain integer (not unsigned/smallint) for forward-compat with
-- per-cycle metadata extensions.

ALTER TABLE public.circle_discussions
  ADD COLUMN IF NOT EXISTS integration_cycles_count integer NOT NULL DEFAULT 0;
