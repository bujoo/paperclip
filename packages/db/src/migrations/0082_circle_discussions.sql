-- Phase 1.14 — Circle Discussions.
--
-- A circle discussion is a multi-agent conversation pattern that composes the
-- Phase 1.13 primitives (a2a_context_id threading, neighbourhood snapshot,
-- issue lifecycle) into a recorded outcome. Drop a statement onto a circle;
-- every member contributes (one issue per turn, all sharing the same
-- a2a_context_id); the round scheduler advances rounds and, when planned
-- rounds complete, asks the Secretary role-holder to summarise. The summary
-- is parsed back into `conclusion` + `conclusion_kind`.
--
-- v1 is circle-scoped (Holacracy's canonical deliberation unit). Future
-- ad-hoc cross-circle discussions can ride the same primitive with
-- circle_id = NULL and explicit participant_agent_ids[], but that's not
-- exercised here.
--
-- The table lives in `public` because it references public.companies and
-- public.agents. The circle_id is logically a FK to plugin-holacracy's
-- circles table but we do not declare it cross-schema (the plugin schema
-- name is install-dependent).

CREATE TABLE IF NOT EXISTS public.circle_discussions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  circle_id uuid NOT NULL,
  a2a_context_id text NOT NULL,
  topic text NOT NULL,
  prompt_for_agents text,
  initiated_by_agent_id uuid REFERENCES public.agents(id),
  initiated_by_user_id text,
  participant_agent_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'open',
  rounds_planned integer NOT NULL DEFAULT 1,
  rounds_completed integer NOT NULL DEFAULT 0,
  conclusion text,
  conclusion_kind text,
  started_at timestamptz NOT NULL DEFAULT now(),
  concluded_at timestamptz,
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS circle_discussions_circle_status_idx
  ON public.circle_discussions (circle_id, status);

CREATE INDEX IF NOT EXISTS circle_discussions_context_idx
  ON public.circle_discussions (a2a_context_id);
