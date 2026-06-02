# Workflow Template Library
## Agent-to-Agent Handoff Patterns for Holacracy AI Company

Source frameworks:
- Holacracy (Robertson): distributed authority via role delegation, not task delegation
- High Output Management (Grove): manager output = team output; meetings as production steps
- Getting Teams Done: Lead Link delegates accountabilities+authority to roles
- 5 Levels of Leadership (Maxwell): authority flows through role, not person
- GTD (Allen): capture → clarify → organize → engage

Anti-pattern: heroic leadership (1 agent does everything outside their role)
Pattern: explicit handoff contracts enforce role boundaries + output expectations

---

## Template Format

```yaml
id: <uuid or slug>
name: <human name>
description: <one sentence>
trigger: <when this workflow applies — label, keyword, issue type>
circle: <owning circle>
steps:
  - step_number: 1
    role_name: <Holacracy role name>
    title: <what this role does>
    inputs: [<what it needs from previous step>]
    outputs: [<what it produces for next step>]
    sla_days: <integer>
    blocks_next_step: true|false
handoff_rules:
  - from_role: <role>
    to_role: <role>
    condition: <when handoff triggers>
    method: <sub-issue|comment|direct-assign>
```

---

## Template 1: Feature Request Pipeline

**Trigger:** issue label = `feature-request` OR title contains "feature:"
**Circle:** General Company Circle → Engineering

```yaml
id: feature-request-pipeline
name: Feature Request Pipeline
description: Routes feature requests from validation through implementation to documentation.
trigger: "label:feature-request OR title:feature:"
circle: General Company Circle
steps:
  - step_number: 1
    role_name: PM Coordinator
    title: Validate and scope feature
    inputs:
      - raw feature request (title + description)
    outputs:
      - validated requirement doc (problem statement, success criteria, scope boundary)
      - priority assessment (critical/high/medium/low)
      - assigned circle/role
    sla_days: 1
    blocks_next_step: true

  - step_number: 2
    role_name: Dev Lead
    title: Technical design
    inputs:
      - validated requirement from step 1
    outputs:
      - technical design doc (approach, risks, effort estimate in days)
      - sub-tasks list if needed
    sla_days: 2
    blocks_next_step: true

  - step_number: 3
    role_name: Dev Lead
    title: Implementation
    inputs:
      - technical design from step 2
    outputs:
      - working code (committed, tested locally)
      - PR or diff reference
    sla_days: 5
    blocks_next_step: true

  - step_number: 4
    role_name: QA Lead
    title: Test and verify
    inputs:
      - PR/diff from step 3
      - success criteria from step 1
    outputs:
      - test results (pass/fail per criterion)
      - sign-off or blocker list
    sla_days: 2
    blocks_next_step: true

  - step_number: 5
    role_name: Doc Lead
    title: Document
    inputs:
      - completed feature (steps 3+4)
      - requirement doc (step 1)
    outputs:
      - updated docs (API docs, runbook, or changelog entry)
    sla_days: 1
    blocks_next_step: false

handoff_rules:
  - from_role: PM Coordinator
    to_role: Dev Lead
    condition: scope validated, priority set
    method: sub-issue with template reference

  - from_role: Dev Lead (design)
    to_role: Dev Lead (impl)
    condition: design approved (same role, sequential)
    method: status update on sub-issue

  - from_role: Dev Lead
    to_role: QA Lead
    condition: implementation complete, PR ready
    method: sub-issue with PR link in description

  - from_role: QA Lead
    to_role: Doc Lead
    condition: all tests pass, sign-off given
    method: sub-issue

  - from_role: QA Lead
    to_role: Dev Lead
    condition: blockers found
    method: comment on impl sub-issue (reopen)
```

---

## Template 2: Research Request Pipeline

**Trigger:** issue label = `research` OR title contains "research:" OR "investigate:"
**Circle:** R&D Circle

```yaml
id: research-request-pipeline
name: Research Request Pipeline
description: Routes research questions from intake through synthesis to strategic recommendation.
trigger: "label:research OR title:research: OR title:investigate:"
circle: R&D Circle
steps:
  - step_number: 1
    role_name: PM Coordinator
    title: Clarify research question
    inputs:
      - raw request (what do we want to know?)
    outputs:
      - scoped question (single answerable question)
      - success criteria (what answer looks like)
      - deadline
    sla_days: 1
    blocks_next_step: true

  - step_number: 2
    role_name: Researcher
    title: Execute research
    inputs:
      - scoped question from step 1
      - success criteria
    outputs:
      - research findings doc (sources, data, synthesis)
      - key insights (bullet list, max 5)
    sla_days: 3
    blocks_next_step: true

  - step_number: 3
    role_name: Strategist
    title: Strategic synthesis
    inputs:
      - research findings from step 2
      - company goals context
    outputs:
      - strategic recommendation (recommend/don't, rationale, risk)
      - action items if any (optional)
    sla_days: 1
    blocks_next_step: true

  - step_number: 4
    role_name: PM Coordinator
    title: Route to action
    inputs:
      - strategic recommendation from step 3
    outputs:
      - new issue created if action needed
      - original request marked done
    sla_days: 1
    blocks_next_step: false

handoff_rules:
  - from_role: PM Coordinator
    to_role: Researcher
    condition: question scoped
    method: sub-issue

  - from_role: Researcher
    to_role: Strategist
    condition: findings complete
    method: sub-issue with findings doc link

  - from_role: Strategist
    to_role: PM Coordinator
    condition: recommendation written
    method: comment on parent issue
```

---

## Template 3: Customer/Board Feedback Pipeline

**Trigger:** issue origin = board (userId set) AND no assignee OR label = `feedback`
**Circle:** Operations Circle → General Company Circle

```yaml
id: board-feedback-pipeline
name: Board Feedback Pipeline
description: Routes board/customer input through triage to correct circle for execution.
trigger: "origin:board AND no-assignee OR label:feedback"
circle: General Company Circle
steps:
  - step_number: 1
    role_name: PM Coordinator
    title: Triage and classify
    inputs:
      - raw board input (title + description)
    outputs:
      - classification (bug/feature/research/governance/ops)
      - target circle + role
      - priority
    sla_days: 0
    blocks_next_step: true

  - step_number: 2
    role_name: "target circle Lead Link"
    title: Decompose within circle
    inputs:
      - classified + prioritized issue from step 1
    outputs:
      - sub-issues assigned to appropriate roles in circle
      - OR direct execution if single-role work
    sla_days: 1
    blocks_next_step: false

handoff_rules:
  - from_role: PM Coordinator
    to_role: target circle Lead Link
    condition: classification complete
    method: assign issue to target agent, set project

  - from_role: PM Coordinator
    to_role: Workflow Architect
    condition: classification unclear / process gap found
    method: raise governance tension in GCC
```

---

## Template 4: Governance Tension Pipeline

**Trigger:** Holacracy tension raised (type = governance) OR issue contains "governance tension"
**Circle:** General Company Circle

```yaml
id: governance-tension-pipeline
name: Governance Tension Pipeline
description: Processes governance tensions from identification through resolution via proper Holacracy channels.
trigger: "tension:governance OR title:governance tension"
circle: General Company Circle
steps:
  - step_number: 1
    role_name: Workflow Architect
    title: Assess and document tension
    inputs:
      - raw tension description
    outputs:
      - structured tension (current state, ideal state, proposal)
      - affected roles/circles
      - urgency (urgent = next meeting, normal = queue)
    sla_days: 1
    blocks_next_step: true

  - step_number: 2
    role_name: Facilitator
    title: Schedule and facilitate governance meeting
    inputs:
      - documented tension from step 1
    outputs:
      - governance meeting outcome (pass/objection/amended/defer)
      - recorded decision if passed
    sla_days: 3
    blocks_next_step: true

  - step_number: 3
    role_name: Secretary
    title: Record governance change
    inputs:
      - meeting outcome from step 2
    outputs:
      - updated governance record (role/policy/domain change)
      - notification to affected agents
    sla_days: 1
    blocks_next_step: true

  - step_number: 4
    role_name: Workflow Architect
    title: Update operational playbooks
    inputs:
      - governance change from step 3
    outputs:
      - updated workflow docs/templates if affected
      - closed tension
    sla_days: 1
    blocks_next_step: false

handoff_rules:
  - from_role: Workflow Architect
    to_role: Facilitator
    condition: tension structured and ready for meeting
    method: sub-issue

  - from_role: Facilitator
    to_role: Secretary
    condition: decision reached
    method: sub-issue with meeting notes

  - from_role: Secretary
    to_role: Workflow Architect
    condition: governance recorded
    method: sub-issue

  - from_role: any role
    to_role: Facilitator
    condition: objection raised during processing
    method: raise new governance tension (escalate)
```

---

## Template 5: L&D Intelligence Distribution

**Trigger:** Scheduled (weekly) OR label = `intelligence-distribution`
**Circle:** R&D Circle

```yaml
id: ld-intelligence-distribution
name: L&D Intelligence Distribution
description: Weekly pipeline that scans, curates, and distributes relevant AI/org intelligence to all circles.
trigger: "label:intelligence-distribution OR schedule:weekly"
circle: R&D Circle
steps:
  - step_number: 1
    role_name: Researcher
    title: Scan and identify relevant intelligence
    inputs:
      - configured sources (arxiv, blogs, newsletters)
      - circle focus areas
    outputs:
      - shortlist of 5-10 relevant items (title, source, relevance note)
    sla_days: 1
    blocks_next_step: true

  - step_number: 2
    role_name: Researcher
    title: Curate and synthesize
    inputs:
      - shortlist from step 1
    outputs:
      - curated brief (2-3 sentences per item, why it matters)
      - items ingested to knowledge base if applicable
    sla_days: 1
    blocks_next_step: true

  - step_number: 3
    role_name: PM Coordinator
    title: Distribute to circles
    inputs:
      - curated brief from step 2
    outputs:
      - circle-specific issues created with relevant items
      - weekly intelligence summary comment on R&D project
    sla_days: 1
    blocks_next_step: false

handoff_rules:
  - from_role: Researcher (scan)
    to_role: Researcher (curate)
    condition: scan complete (same role, sequential)
    method: status update

  - from_role: Researcher
    to_role: PM Coordinator
    condition: brief complete
    method: sub-issue with brief attached
```

---

## PM Coordinator Routing Guide

When PM Coordinator receives an unrouted issue, match against templates:

| Signal | Template | First Step Agent |
|--------|----------|-----------------|
| label:feature-request | Feature Request Pipeline | PM Coordinator |
| label:research | Research Request Pipeline | PM Coordinator |
| origin:board + no assignee | Board Feedback Pipeline | PM Coordinator |
| tension:governance | Governance Tension Pipeline | Workflow Architect |
| label:intelligence | L&D Distribution | Researcher |
| No match | Raise governance tension: "Routing gap for issue type X" | Workflow Architect |

**Sub-issue creation pattern:**
- Title: `[{PARENT_ID}] {RoleName} - {step.title}`
- Description: `Part of workflow: {workflow.name}\n\n**Inputs required:**\n{step.inputs}\n\n**Outputs expected:**\n{step.outputs}\n\nSLA: {step.sla_days} day(s)`
- Assign to: agent filling the role in that circle
- Parent: original issue

---

## Governance Note

Per GCC policy "Intra-Circle Decomposition":
> When an issue requires multiple roles, the Lead Link or PM Coordinator MUST use a workflow template to create role-scoped sub-issues rather than assigning the whole issue to one agent.

This enforces Holacracy's distributed authority principle: each role owns its step. No heroic leadership.
