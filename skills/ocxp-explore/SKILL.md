---
name: ocxp-explore
description: Use when exploring unfamiliar code, understanding architecture, tracing call chains, finding where to make changes, or navigating to relevant files for a task. Requires OCXP MCP tools to be available.
---

# Codebase Exploration with OCXP

Navigate codebases using OCXP's semantic code graph instead of manual file reading. OCXP tools understand code structure, relationships, and meaning -- not just text.

## Workflow

Given: "$ARGUMENTS" (task, question, or area to explore)

### 1. Orient

Call `ocxp_warmup`. This returns the module tree, entry points, key types, and community structure in ~150 tokens. Do this even if you think you know the codebase.

### 2. Navigate

**For a task** ("add rate limiting", "fix auth bug"): Call `ocxp_route` with the task description.
- Route returns ordered waypoints with token-budgeted context
- The response is self-sufficient -- you should NOT need follow-up calls
- Use `mode: "modify"` for changes, `mode: "impact"` for blast radius, `mode: "comprehend"` (default) for understanding
- Use `scope` to narrow to a subdirectory (e.g. `"src/api/"`) -- always combine with `focus_repo` to prevent cross-repo leakage (scope alone is a soft filter)
- For blast radius, prefer `ocxp_references` on the entity over `mode: "impact"` -- references use graph edges while impact mode can pull in semantically similar but unrelated entities

**For a concept** ("how does caching work", "error handling patterns"): Call `ocxp_search` with the concept.
- Semantic search matches by meaning, not keywords
- Returns ranked entities with relevance scores

### 3. Deepen (only if needed)

- `ocxp_zoom` on a specific entity for progressive detail (L0 -> L1 -> L2 -> L3)
- `ocxp_entity` for a single entity's full UCU card with relationships
- `ocxp_query` for advanced 5D navigation with intent detection (trace, impact, explain, locate)
  - Use `output_mode: "default"` to keep output structured (~8K chars) or `"summary"` for metrics only

### 4. Analyze relationships

- `ocxp_references` to find everything that calls/imports/uses an entity (the most precise blast radius tool)
- `ocxp_glossary` to map domain terms to code types and struct definitions
- `ocxp_topology` for service-level dependency maps -- use `output_mode: "summary"` for large services
- `ocxp_infra` for infrastructure topology -- use `output_mode: "default"` to prevent overflow on large infra graphs

### 5. Present findings

Summarize with:
- Key files and their roles
- Relationships between components
- Which subsystems/communities are involved
- Entry points for the task

## Tool selection guide

| Need | Tool | Why |
|------|------|-----|
| Start any exploration | `ocxp_warmup` | Instant orientation, ~150 tokens |
| Task-oriented navigation | `ocxp_route` | Self-sufficient ordered waypoints |
| Find by meaning | `ocxp_search` | Semantic, not keyword |
| Single entity deep-dive | `ocxp_entity` | Full UCU card |
| What calls/uses X? | `ocxp_references` | Reverse dependency lookup |
| Service architecture | `ocxp_topology` | Upstream/downstream deps |
| Domain concepts | `ocxp_glossary` | Terms -> types mapping |
| Progressive detail | `ocxp_zoom` | L0 -> L3 drill-down |

## Rules

- Always warmup first, even if it seems unnecessary
- Prefer `ocxp_route` over `ocxp_search` for task-oriented work
- Prefer OCXP tools over raw file reading -- they provide structural context, not just text
- One `ocxp_route` call replaces 5-10 manual file reads
