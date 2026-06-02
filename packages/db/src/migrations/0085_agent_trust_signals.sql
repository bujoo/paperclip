-- Phase 1.15f — Trust-per-skill signals.
--
-- Tracks agent-to-agent trust on a per-skill basis. Auto-updated by the
-- holacracy-talk-to-agent reply hook: on TASK_STATE_COMPLETED, increment
-- successful_exchanges; on timeout/failure, increment failed_exchanges.
--
-- skill_slug is derived from the calling task's accountability context, or
-- 'general' when no skill can be inferred.

CREATE TABLE IF NOT EXISTS public.agent_trust_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  truster_agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  trusted_agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  skill_slug text NOT NULL DEFAULT 'general',
  successful_exchanges integer NOT NULL DEFAULT 0,
  failed_exchanges integer NOT NULL DEFAULT 0,
  last_exchange_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.agent_trust_signals
    ADD CONSTRAINT agent_trust_signals_unique_triple
    UNIQUE (truster_agent_id, trusted_agent_id, skill_slug);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS agent_trust_signals_truster_idx
  ON public.agent_trust_signals (truster_agent_id, last_exchange_at DESC);
