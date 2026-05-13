---
name: ocxp-plan
description: Use when planning features, refactors, or understanding the impact of proposed changes before writing code. Generates structured implementation plans using code graph intelligence. Requires OCXP MCP tools to be available.
---

# Implementation Planning with OCXP

Generate implementation plans grounded in actual codebase structure using OCXP's route + spec generation. Plans are based on the code graph, not guesswork.

## Workflow

Given: "$ARGUMENTS" (feature request, refactor goal, or change description)

### 1. Orient

Call `ocxp_warmup` for codebase orientation -- module tree, entry points, key types.

### 2. Generate plan

Call `ocxp_plan` with the request. This is the most efficient tool -- it combines route + spec in one call:
- Returns ordered navigation waypoints AND a YAML implementation spec
- Use `mode: "modify"` for implementation tasks (default: "comprehend")
- Use `scope` to narrow to a subdirectory if the change is localized -- always combine with `focus_repo` to prevent cross-repo leakage
- Use `output_mode: "default"` to keep output structured (~8K chars) and prevent overflow
- Use `max_tokens` to control route token budget

### 2b. Validate references

Extract all function names, file paths, and infrastructure references from the spec YAML returned by `ocxp_plan`. Call `ocxp_spec_validate` with them as a batch:

```
ocxp_spec_validate(references: [
  {type: "function", name: "function_name", file: "path.py"},
  {type: "file", name: "src/path/to/file.py"},
  {type: "dynamo_table", name: "table_name"},
  ...
])
```

If any references FAIL:
1. Use `ocxp_search` to find the correct path
2. Fix the reference in the plan
3. Report corrections to the user ("Corrected path: X -> Y")

Do NOT proceed with failed references -- they indicate hallucinated paths that will waste implementation time.

### 2c. Compliance check

Feed the full spec YAML from `ocxp_plan` into `ocxp_spec_compliance`:

```
ocxp_spec_compliance(spec: "<the YAML spec string>", format: "markdown")
```

**Important:** The `spec` parameter must contain actual YAML content with real newlines, not escaped strings (e.g. `\n`). If you get a YAML parse error, check that the YAML is passed as-is, not string-escaped.

Review the score:
- **100%**: proceed to context analysis
- **Failures**: flag to user with specific checks that failed and why. Adjust the plan if needed.
- **Warnings**: note but proceed (usually means files will be created during implementation)

### 3. Understand context

- `ocxp_topology` -- service-level dependencies affected by the change
- `ocxp_community` -- which subsystems are involved and their boundaries
- `ocxp_constraints` -- naming conventions and architectural rules to follow

### 4. Assess impact

For each key entity in the plan:
- `ocxp_references` -- what calls/imports/uses it? (blast radius)
- Check if modifications cascade through the dependency chain

### 5. Output structured plan

Present:

**Scope**: Which subsystems/communities are affected

**Files to modify** (ordered by dependency -- modify dependencies first):
- File path, what to change, why

**New files to create**:
- File path, purpose, which patterns to follow (from constraints)

**Impact analysis**:
- Entities affected by the change
- Downstream consumers that may need updates
- Cross-repo edges if applicable

**Constraints to follow**:
- Naming conventions from `ocxp_constraints`
- Module boundary rules
- Existing patterns to match

**Risks and edge cases**:
- Breaking changes to public APIs
- Missing test coverage for affected paths
- Cross-subsystem dependencies

**Test strategy**:
- What to test based on `ocxp_test_quality` gaps
- Which existing tests might break

## Tips

- `ocxp_plan` replaces 5-10 manual query+entity chains -- start there
- Always run `ocxp_spec_validate` after generating a plan -- LLMs hallucinate file paths
- Always run `ocxp_spec_compliance` to verify the plan follows codebase rules
- Use `mode: "impact"` for broad blast radius analysis, but for precise impact use `ocxp_references` on the entity -- impact mode can pull in semantically similar but unrelated entities
- For large changes, use `scope` to plan subsystem by subsystem
- Check `ocxp_diff` after implementation to verify structural changes match the plan
- The full pipeline: `ocxp_plan` -> `ocxp_spec_validate` -> `ocxp_spec_compliance` -> implement -> `ocxp_plan_validate`
