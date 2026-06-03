-- T2 (Phase 1.19 A-set) — required_skills on issues
--
-- Tasks can now declare which skill slugs they need. Agents read this
-- column on inbound assignment and compare against their own skill
-- trust profile (B-set). If a skill is missing or below threshold,
-- they decline via the structured `agentDeclineTask` MCP tool.
--
-- The column is nullable + defaults to empty array; existing issues
-- without required_skills are treated as "no specific skill needed —
-- proceed with general competence". Vector match (V-set) populates
-- this column at issue-create time via best-effort LLM extraction
-- when the caller doesn't set it explicitly.

ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS required_skills text[] NOT NULL DEFAULT '{}'::text[];

-- Index for the common query: "which issues need skill X?"
CREATE INDEX IF NOT EXISTS issues_required_skills_gin_idx
  ON public.issues USING GIN (required_skills);

COMMENT ON COLUMN public.issues.required_skills IS
  'Phase 1.19 A-set — list of skill slugs this task needs. Agents check via agentCheckSkillFit before accepting.';
