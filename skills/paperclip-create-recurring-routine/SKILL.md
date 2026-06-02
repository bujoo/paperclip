---
name: paperclip-create-recurring-routine
description: Create a recurring routine in Paperclip that spawns issues on a schedule. Use this whenever you need a "weekly meeting", "monthly review", "daily standup", "quarterly audit", or any other recurring obligation. The routine + cron trigger pair IS the canonical recurring-event primitive — do NOT just create child issues and mark the parent done.
---

# Create a recurring routine in Paperclip

When an issue asks you to "schedule a recurring meeting", "create weekly events", "set up monthly reviews", or anything that repeats on a calendar, your job is to create a **routine** + at least one **schedule trigger**. Each time the trigger fires, Paperclip spawns a fresh issue from the routine's template — that's the recurring meeting being "held."

**Do NOT** just create child issues and mark the parent done. Static child issues don't recur. The routine + trigger pair is the only thing that recurs.

## Anti-pattern to avoid

If you find yourself writing prose like:

> "✅ Implementation Decomposed into 5 Circle-Scoped Tasks. MYA-265: Workflow Automation governance (Mon 2:00 PM) + tactical (Thu 4:00 PM). All assigned to Secretary."

— **STOP.** You're documenting cadence, not creating routines. Those 5 child issues will sit in `todo` forever. The schedule is paperwork without a cron expression behind it.

## When to use this skill

Triggers for using this skill:
- Issue mentions "recurring", "weekly", "monthly", "daily", "quarterly", "every N days"
- Issue mentions "calendar event", "meeting schedule", "cadence"
- A Holacracy tactical or governance meeting needs to be scheduled
- A periodic review, audit, or check-in needs to happen on a clock

If the work is one-shot ("create a launch plan", "fix this bug"), use regular issues instead — routines are only for things that REPEAT.

## Step 0 — Resolve your circle's root project

Every circle has **one root project** (named after the circle) that holds its meta-work — including routines and goals. If you create a routine without a `projectId`, it lands in the null-project bucket and won't show up alongside the rest of the circle's work. **Always resolve and set `projectId`.**

Find your circle's root project id in one of two ways:

1. **From your snapshot** — your active discussion / heartbeat snapshot includes your `circleId`. Use that.
2. **Query the circle directly:**

```bash
curl -sS "$PAPERCLIP_API_BASE/api/plugins/<holacracy-plugin-uuid>/api/circles/$CIRCLE_ID?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq -r '.projectId'
```

Save the returned UUID as `PROJECT_ID` — you'll pass it as `projectId` on every routine you create below.

## Step 1 — Create the routine

```bash
curl -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Engineering — Weekly Tactical Meeting",
    "description": "Walk the checklist, surface blockers, assign next actions. 1.5h. Attendees: Circle Lead + Facilitator + Secretary + Rep Link.",
    "assigneeAgentId": "<facilitator-agent-uuid>",
    "priority": "medium",
    "status": "active",
    "projectId": "<resolved-project-id>",
    "parentIssueId": "<the-issue-that-asked-for-this>",
    "variables": [
      {"name": "circleName", "value": "Engineering"},
      {"name": "meetingType", "value": "tactical"}
    ]
  }'
```

The response contains the routine `id` — you need it for step 2.

**Required fields:** `title`. Everything else has sane defaults.

**`assigneeAgentId`** — the agent who will receive each spawned issue. For Holacracy meetings, this is usually the **Facilitator** of the circle (they run the meeting). The Secretary captures minutes after.

**`projectId`** — the circle's root project (resolved in Step 0). Without this, spawned issues land in the null-project bucket. Required for the routine + every spawned issue to roll up under the circle.

**`parentIssueId`** — link back to the issue that requested this routine so the work trail is clear.

**`variables`** — key/value pairs that template the spawned issue title/description.

## Step 2 — Attach a schedule trigger (cron)

```bash
curl -X POST "$PAPERCLIP_API_BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "schedule",
    "label": "Mondays 14:00 UTC",
    "enabled": true,
    "cronExpression": "0 14 * * 1",
    "timezone": "UTC"
  }'
```

The cron format is standard 5-field: `minute hour day-of-month month day-of-week`.

## Cron quick reference

| Cadence | Cron | Meaning |
|---|---|---|
| Mondays 14:00 UTC | `0 14 * * 1` | Every Monday at 2pm UTC |
| Tuesdays 14:00 UTC | `0 14 * * 2` | Every Tuesday at 2pm UTC |
| Wednesdays 14:00 UTC | `0 14 * * 3` | day-of-week: 0=Sun, 1=Mon, … 6=Sat |
| Thursdays 13:00 UTC | `0 13 * * 4` | |
| Thursdays 16:00 UTC | `0 16 * * 4` | |
| Fridays 14:00 UTC | `0 14 * * 5` | |
| Every weekday 09:00 | `0 9 * * 1-5` | Mon-Fri |
| 1st of month, 09:00 | `0 9 1 * *` | Monthly |
| Every 6 hours | `0 */6 * * *` | Steward-tick cadence |
| Daily at midnight UTC | `0 0 * * *` | |

For 30-min offsets use `30` in the minute slot: `30 15 * * 3` = Wed 15:30 UTC.

## Step 3 — Verify the routine + trigger fired

```bash
# Get routine + its triggers
curl -sS "$PAPERCLIP_API_BASE/api/routines/$ROUTINE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq .

# Expect: status=active, triggers[0].cron_expression matches, triggers[0].next_run_at is the next firing time
```

The `next_run_at` field on the trigger tells you when the next execution will happen. If it's in the past, something is misconfigured.

## Concrete pattern — Holacracy meeting cadence

For a circle with weekly governance + tactical meetings, create **two routines** (not one with two triggers — they have different titles/agendas):

```bash
# Governance routine
ROUTINE_GOV=$(curl -sS -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Engineering — Weekly Governance Meeting",
    "description": "Process tensions, evolve roles + policies, integrate objections per IDM. 1.5h.",
    "assigneeAgentId": "'$FACILITATOR_ID'",
    "projectId": "'$PROJECT_ID'",
    "parentIssueId": "'$PARENT_ISSUE_ID'",
    "variables": [{"name":"circleName","value":"Engineering"},{"name":"meetingType","value":"governance"}]
  }' | jq -r .id)

curl -X POST "$PAPERCLIP_API_BASE/api/routines/$ROUTINE_GOV/triggers" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","label":"Wed 14:00 UTC","cronExpression":"0 14 * * 3","timezone":"UTC"}'

# Tactical routine
ROUTINE_TAC=$(curl -sS -X POST "$PAPERCLIP_API_BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Engineering — Weekly Tactical Meeting",
    "description": "Walk the checklist, surface blockers, assign next actions. 1.5h.",
    "assigneeAgentId": "'$FACILITATOR_ID'",
    "projectId": "'$PROJECT_ID'",
    "parentIssueId": "'$PARENT_ISSUE_ID'",
    "variables": [{"name":"circleName","value":"Engineering"},{"name":"meetingType","value":"tactical"}]
  }' | jq -r .id)

curl -X POST "$PAPERCLIP_API_BASE/api/routines/$ROUTINE_TAC/triggers" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","label":"Wed 15:30 UTC","cronExpression":"30 15 * * 3","timezone":"UTC"}'
```

Loop this for every circle. For an org with 5 circles × 2 meeting types = 10 routines + 10 triggers.

## Optional fields worth knowing

- `concurrencyPolicy`: `coalesce_if_active` (default — skip if previous still running) | `serial` | `parallel`
- `catchUpPolicy`: `skip_missed` (default — don't backfill if the server was down) | `run_once_then_resume`
- `timezone`: `UTC` (default), `Europe/Amsterdam`, `America/New_York`, etc. Use UTC unless you have a strong reason — DST changes break schedules.
- Trigger `kind` can also be `webhook` (external system calls it) or `api` (internal trigger via API). Schedule is the most common.

## When you're done

Comment on the original issue with a summary:

> ✅ Created 2 routines + 2 schedule triggers for Engineering circle. Governance runs Wed 14:00 UTC, Tactical runs Wed 15:30 UTC. Both assigned to Facilitator. Next governance fires `<next_run_at from response>`.

Then close the issue. **Do NOT spawn child issues to "implement" the routines** — the routines ARE the implementation.

## Files for reference

- API routes: `server/src/routes/routines.ts`
- Schema validators: `packages/shared/src/validators/routine.ts`
- Schema: `routines` + `routine_triggers` tables in `public.*`
