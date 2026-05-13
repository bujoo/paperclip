---
name: holacracy-governance-meeting
description: Run a Holacracy v5 Governance Meeting as Facilitator. Follow the Integrative Decision-Making process to change official rules and expectations.
---

# Governance Meeting (Holacracy v5)

Purpose: Change official rules and expectations.

You are the Facilitator. Follow these 4 steps exactly. Governance outputs: create/modify/remove Roles, Accountabilities, Domains, Policies.

## Step 1: Check-In Round

Create a child issue for each circle member:
"[Governance] Check-in: {Agent Name}"
Description: "Share your current state. No discussion."

## Step 2: Build Agenda

Query governance tensions via holacracy-list-tensions (type: "governance").
Ask each circle member: "What governance tensions do you have? One or two words per item."
Collect all as agenda items.

## Step 3: Process Agenda Items (Integrative Decision-Making)

For each agenda item, follow this exact sequence:

### 3a. Present Proposal (Proposer speaks)
The tension owner states their proposal. Others can help ONLY if asked, and ONLY to craft an initial proposal -- not to improve it or reach consensus.

A valid governance proposal must do one of:
- Create, modify, or remove a Role (name, purpose, accountabilities)
- Create, modify, or remove a Domain
- Create, modify, or remove a Policy
- Elect someone to a role

### 3b. Clarifying Questions (Anyone asks)
Anyone may ask questions to understand the proposal. NOT to influence.
No discussion. No reactions. Proposer may respond "Not specified."

### 3c. Reaction Round (Everyone except proposer)
Each participant shares a reaction, one at a time. No discussion.
Reactions are directed to the space, not to individuals.

### 3d. Option to Clarify (Proposer only)
Proposer may amend the proposal. No obligation to do so.
No one else may speak.

### 3e. Objection Round (Everyone including proposer)
Ask each participant: "Do you see any reason why adopting this proposal causes harm? Objection or no objection?"

Test each objection against ALL criteria (must meet all to be valid):
1. Does the proposal cause harm (not just "is it incomplete")?
2. Would the proposal limit one of YOUR roles (not helping another role)?
3. Is the harm created by THIS proposal (not pre-existing)?
4. Is it based on known data or necessarily predictive (not speculative)?
5. Could significant harm happen before we can adapt (is it safe enough to try)?

Special: "Not Valid Governance Output" is automatically valid if the proposal breaks constitutional rules.

If NO objections: proposal is ADOPTED. Use the holacracy API to implement:
- PATCH /circles/{circleId}/roles/{roleId} for role changes
- POST /circles/{circleId}/policies for new policies
- holacracy-log-action to record the governance change

### 3f. Integration (If valid objections)
Work with the proposer AND objector to amend the proposal:
- Ask objector: "What can be added or changed to remove that issue?"
- For each idea, ask objector: "Would this resolve your objection?"
- If yes, ask proposer: "Would this still address your tension?"
- After all objections integrated, repeat the Objection Round.

## Step 4: Closing Round

Each participant shares a closing reflection. No discussion.

## Step 5: Board Review (HITL - Required for Governance)

ALL governance proposals that were adopted MUST be reviewed by the board before implementation.

Create a request_confirmation interaction:
- List all adopted proposals with their governance changes
- List any roles/policies/domains that would be modified
- Ask: "Board: approve these governance changes or provide feedback."
- Set `supersedeOnUserComment: true`

This is the two-tier authority checkpoint. Governance changes are structural and require human sign-off.

## After the Meeting

1. Secretary records all governance changes via holacracy-log-action
2. Update the audit trail with all adopted proposals
3. Post summary: proposals adopted, proposals rejected, tensions deferred
4. For structural changes (two-tier authority): flag for human review before implementing

## Structural vs Behavioral Issues (AI Agent Protocol)

If a tension reveals an agent making errors:
- **Structural issue** (role scope too broad/narrow): Fix via governance proposal (modify role accountabilities/domains)
- **Behavioral issue** (agent acting wrong within proper scope): Flag for configuration fix (update agent instructions/model/prompts)
