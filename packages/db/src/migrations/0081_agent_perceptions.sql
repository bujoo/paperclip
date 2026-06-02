-- Phase 1.13 — Ears (broadcast perceptions).
--
-- When an event topic (e.g. `paperclip/v1/event/{c}/{circle}/+` circle
-- broadcast) is delivered to an agent's subscription, the inbound handler now
-- records the message as a perception instead of materialising it as a new
-- issue. Perceptions are peripheral awareness — they flow into the agent's
-- run context the next time the agent wakes for any reason. Direct
-- request-topic Tasks continue to create issues.
--
-- App-level idempotency: `idempotency_key = sha256(agentId|topic|payloadHash)`
-- is filled by the inbound handler and used for a SELECT-then-INSERT dedupe
-- window (60s) so a redelivered message doesn't double-insert. We do not use
-- a UNIQUE constraint here because (a) the plugin migration validator rejects
-- `CREATE UNIQUE INDEX`, and (b) older rows are intentionally allowed to
-- coexist with the same key (they're already "consumed").

CREATE TABLE IF NOT EXISTS public.agent_perceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  topic text NOT NULL,
  payload_json jsonb NOT NULL,
  user_properties jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  idempotency_key text
);
CREATE INDEX IF NOT EXISTS agent_perceptions_agent_consumed_idx
  ON public.agent_perceptions (agent_id, consumed_at);
CREATE INDEX IF NOT EXISTS agent_perceptions_agent_received_idx
  ON public.agent_perceptions (agent_id, received_at DESC);
CREATE INDEX IF NOT EXISTS agent_perceptions_idempotency_idx
  ON public.agent_perceptions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
