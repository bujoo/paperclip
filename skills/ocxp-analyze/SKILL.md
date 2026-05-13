---
name: ocxp-analyze
description: Use when auditing code quality, finding dead code, checking test coverage, identifying architectural violations, discovering research gaps, or assessing codebase health. Requires OCXP MCP tools to be available.
---

# Codebase Analysis with OCXP

Run comprehensive analysis using OCXP's graph-based code intelligence. All analysis is deterministic (no LLM) and based on structural graph properties.

## Workflow

Given: "$ARGUMENTS" (focus area, or empty for full analysis)

### 1. Orient and check health

Call `ocxp_warmup` for codebase orientation, then `ocxp_status` to check index health.

If status shows stale files or missing entities, suggest running `ocxp_index` with `path: "."` before proceeding.

### 2. Run targeted analysis

Based on the focus area, run the relevant tools. Use `output_mode: "summary"` for initial triage, `"default"` for structured detail. This prevents overflow on large codebases.

**Code quality** -- `ocxp_analyze`:
- Categories: `"dead_code"`, `"legacy"`, `"anti_patterns"`, or `"all"`
- Returns findings with confidence scores and file locations
- Use `min_confidence` to filter noise (default 0.5)
- Use `path_filter` to scope to a specific directory (e.g. `"src/api/"`)

**Test quality** -- `ocxp_test_quality`:
- Metrics: test density, structural coverage, mock detection, shallow test detection
- Identifies untested code paths and over-mocked tests

**Research gaps** -- `ocxp_gap_analysis`:
- Discovers CODEBASE, CONTEXT, and DATABASE gaps
- Returns focus areas, key entities, and execution tiers
- Pure graph analysis (~5ms), no LLM

**Architecture** -- `ocxp_constraints`:
- Naming conventions and semantic suffix patterns (*Service, *Repository)
- Module boundaries and violations
- Architectural rules discovered from codebase patterns

### 3. Synthesize findings

Organize by priority:

1. **Critical** (high confidence, high impact): Dead code in hot paths, anti-patterns in core modules, missing tests for critical flows
2. **Warnings** (medium confidence or impact): Legacy patterns, naming violations, shallow tests
3. **Suggestions** (low priority): Style inconsistencies, minor gap areas

For each finding, include: file path, entity name, confidence score, and suggested action.

### 4. Cross-reference

Use `ocxp_references` on flagged entities to assess blast radius. Use `ocxp_community` to identify which subsystems are most affected.

## Quick reference

| Analysis | Tool | Key params |
|----------|------|------------|
| Dead code | `ocxp_analyze` | `categories: "dead_code"`, `output_mode`, `path_filter` |
| Anti-patterns | `ocxp_analyze` | `categories: "anti_patterns"`, `output_mode`, `path_filter` |
| Legacy code | `ocxp_analyze` | `categories: "legacy"`, `output_mode`, `path_filter` |
| Test coverage | `ocxp_test_quality` | `output_mode`, `path_filter` |
| Research gaps | `ocxp_gap_analysis` | `mission`, `output_mode`, `path_filter` |
| Naming rules | `ocxp_constraints` | `scope`, `constraint_type` |
| Index health | `ocxp_status` | `format: "json"` for machine-readable |
| Subsystems | `ocxp_community` | `output_mode`, `max_output_chars` |
| Infra security | `ocxp_analyze` | `categories: "infra_security"`, `output_mode` |
