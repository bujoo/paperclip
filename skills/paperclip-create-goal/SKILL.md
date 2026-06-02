---
name: paperclip-create-goal
description: Create and link goals in Paperclip. Goals are the hierarchical strategic intent (mission → strategy → objective → task) that issues attach to. Use this whenever you set a strategic direction, define an OKR, plan a quarterly objective, or want issues to roll up into a measurable outcome. Linking issues to goals is how you keep work aligned and reportable.
---

# Create and link goals in Paperclip

Paperclip's `goals` table is a **hierarchical strategic-intent tree** with 4 levels: `mission` → `strategy` → `objective` → `task`. Each level can have parent + children. Issues link to goals via the issue's `goal_id` field — that's how individual work rolls up into measurable outcomes.

Use this skill when:
- A Lead Link needs to set the strategy/objectives for their circle
- A circle needs an OKR for the quarter
- An issue should report against a higher-level outcome
- You want a dashboard that says "Doc circle is 60% to its Q2 objective" — that requires goals + issue→goal linkage

## Anti-pattern to avoid

If you find yourself writing a "strategic plan" as a long markdown blob in an issue body, **stop**. Goals are the structured form. Decompose the plan into:
- 1 strategy goal (the long-term aim)
- 2–4 objective goals under it (the measurable outcomes)
- N task goals under each objective (the concrete deliverables)

Then link individual implementation issues to the task goals. The reporting is automatic.

## The 4 goal levels

| Level | What it is | Example | Owner |
|---|---|---|---|
| `mission` | The reason the org exists. One per company, rarely changes. | "Land with the audit; grow with the graph" | GCC Lead Link |
| `strategy` | A multi-quarter aim that advances the mission. | "Become the canonical A2A-over-MQTT reference org" | GCC Lead Link / Sub-circle Lead Link |
| `objective` | A measurable quarterly outcome under a strategy. | "Have 3 external integrators connected via our A2A protocol by 2026-09-30" | Sub-circle Lead Link |
| `task` | A concrete deliverable under an objective. Issues attach here. | "Publish the A2A protocol spec doc with example client code" | Specialist role holder |

## Step 0 — Resolve your circle's root project

Every circle has **one root project** (named after the circle) that holds its meta-work — including goals and routines. If you create a goal without a `projectId`, it lands in the null-project bucket and won't show up alongside the rest of the circle's work. **Always resolve and set `projectId`** on every goal you create.

Find your circle's root project id in one of two ways:

1. **From your snapshot** — your active discussion / heartbeat snapshot includes your `circleId`. Use that.
2. **Query the circle directly:**

```bash
curl -sS "$PAPERCLIP_API_BASE/api/plugins/<holacracy-plugin-uuid>/api/circles/$CIRCLE_ID?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq -r '.projectId'
```

Save the returned UUID as `PROJECT_ID` — you'll pass it as `projectId` on every goal you create below.

## Step 1 — Create a goal

```bash
curl -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Become the canonical A2A-over-MQTT reference org",
    "description": "Position ContextHub as the open-source reference implementation for A2A + MCP over MQTT. Measure: 3+ external integrators by end of 2026.",
    "level": "strategy",
    "status": "planned",
    "projectId": "<resolved-project-id>",
    "ownerAgentId": "<strategist-agent-uuid>"
  }'
```

The response contains the goal `id`. Save it — children + issues reference it.

**Required fields:** `title`.

**Field meanings:**
- `level`: one of `mission` | `strategy` | `objective` | `task` (default `task`)
- `status`: `planned` | `active` | `paused` | `done` | `cancelled` (default `planned`)
- `parentId`: another goal's UUID. Builds the tree.
- `projectId`: the circle's root project (resolved in Step 0). Required — without it the goal lands in the null-project bucket and won't roll up under the circle.
- `ownerAgentId`: who's accountable. Should be a Lead Link for strategy/objective; specialist for task.

## Step 2 — Build the hierarchy

```bash
# Create a strategy under the mission
STRATEGY_ID=$(curl -sS -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Become the canonical A2A-over-MQTT reference org",
    "level": "strategy",
    "parentId": "'$MISSION_ID'",
    "projectId": "'$PROJECT_ID'",
    "ownerAgentId": "'$STRATEGIST_ID'"
  }' | jq -r .id)

# Two objectives under the strategy
OBJ1=$(curl -sS -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Ship public A2A protocol spec + 2 worked example clients by 2026-09-30",
    "level": "objective",
    "parentId": "'$STRATEGY_ID'",
    "projectId": "'$PROJECT_ID'",
    "ownerAgentId": "'$DOC_LEAD_ID'"
  }' | jq -r .id)

OBJ2=$(curl -sS -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Onboard 3 external integrators (n8n, Zapier, design-partner) by 2026-12-31",
    "level": "objective",
    "parentId": "'$STRATEGY_ID'",
    "projectId": "'$PROJECT_ID'",
    "ownerAgentId": "'$GROWTH_LEAD_ID'"
  }' | jq -r .id)

# Tasks under objective 1
curl -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Publish docs/specs/a2a-mqtt-protocol.md with topic schema + payload shapes",
    "level": "task",
    "parentId": "'$OBJ1'",
    "projectId": "'$PROJECT_ID'",
    "ownerAgentId": "'$DOC_LEAD_ID'"
  }'
```

## Step 3 — Link an issue to a goal

When you create or update an issue that contributes to a goal, set `goalId`:

```bash
# On create
curl -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Draft section 1 — topic schema",
    "goalId": "<task-goal-uuid>",
    "assigneeAgentId": "<doc-lead-uuid>"
  }'

# On update of an existing issue
curl -X PATCH "$PAPERCLIP_API_BASE/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{ "goalId": "<task-goal-uuid>" }'
```

## Step 4 — Query progress

```bash
# All goals in the company tree
curl -sS "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq '.[] | {id, title, level, status, parent_id}'

# One goal + its children + linked issues
curl -sS "$PAPERCLIP_API_BASE/api/goals/$GOAL_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq .
```

## Common patterns

### Quarterly OKR for a sub-circle

```
strategy (Lead Link of GCC)
└─ objective (Lead Link of sub-circle, "Doc onboarding median ≤ 2 days by 2026-09-30")
    ├─ task ("Audit current onboarding flow")
    ├─ task ("Build queryable doc index")
    └─ task ("Add weekly digest")
```

### Discussion conclusion → goal

When a SMART discussion concludes with an `expected_output_kind: "next_action"`, the conclusion should become a **task goal** under the circle's current objective. The Secretary writes it up after the discussion:

```bash
curl -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Publish weekly docs digest starting 2026-06-09",
    "level": "task",
    "parentId": "<circle-objective-uuid>",
    "projectId": "<resolved-project-id>",
    "ownerAgentId": "<doc-lead-uuid>",
    "description": "Concluded by GCC discussion <discussion-id> 2026-06-02. Status: support-with-objection from QA; objection noted in MYA-XXX."
  }'
```

## Who owns each goal level (Holacracy)

- **Mission**: GCC Lead Link (defined at constitution adoption, rarely changed)
- **Strategy**: GCC Lead Link, set in GCC governance meetings
- **Objective**: Sub-circle Lead Link for their circle (set in sub-circle governance)
- **Task**: Specialist role holder accountable for the work

If you create a goal at the wrong level for the wrong owner, the structure rots. Check the role before assigning ownership.

## When you're done

Comment on the issue with the goal tree you created:

> ✅ Created strategy → 2 objectives → 5 tasks. Strategy goal: `<uuid>` (owner: Strategist). Linked MYA-XXX through MYA-YYY to the task goals.

Then close the issue. The goals will drive the rest of the work.

## Files for reference

- API routes: `server/src/routes/goals.ts`
- Schema validators: `packages/shared/src/validators/goal.ts`
- Schema: `goals` table in `public.*`
- Issue→goal link: `issues.goal_id`
