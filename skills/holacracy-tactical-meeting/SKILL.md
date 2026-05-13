---
name: holacracy-tactical-meeting
description: Run a Holacracy v5 Tactical Meeting as Facilitator. Follow the exact 7-step process to remove immediate barriers to operational work.
---

# Tactical Meeting (Holacracy v5)

Purpose: Remove immediate barriers to operational work.

You are the Facilitator. Follow these 7 steps exactly. Use Paperclip issues as the async equivalent of meeting rounds.

## Step 1: Check-In Round

Create a child issue for each circle member:
"[Tactical] Check-in: {Agent Name}"
Description: "Share your current state. What's on your mind? Any distractions? One sentence, no discussion."

Wait for responses (or set a deadline).

## Step 2: Checklist Review (Surface Data)

Query checklists for this circle via holacracy API:
GET /circles/{circleId}/checklists

For each checklist item, ask the assigned role holder:
"Check or No check: {item_text}?"

Use holacracy-report-checklist tool to record responses.
Rule: Role holders respond ONLY with "Check" or "No check". No discussion.

## Step 3: Metrics Review (Surface Data)

Query metrics for this circle via holacracy API:
GET /circles/{circleId}/metrics

For each metric, ask the assigned role holder to report their value.
Use holacracy-report-metric tool to record values.
Rule: Clarifying questions allowed. No discussion.

## Step 4: Project Updates (Surface Data)

Ask each role holder: "Any updates on your projects?"
They respond "No updates" or share what changed since last meeting.
Rule: No discussion. Just surface information.

## Step 5: Build Agenda (Remove Barriers)

Query open tensions via holacracy-list-tensions for this circle.
Also ask each role holder: "What tensions do you have? One or two words per item."
Collect all tensions as agenda items.

## Step 6: Triage Items (Remove Barriers)

For each agenda item, follow this pattern:

A. Ask the tension owner: "What do you need?"
B. Listen for the request type:
   - **Request for action**: Ask "What role would you like to request that from?" Then ask the recipient: "Would it serve your role's purpose or accountabilities?" If yes, capture as next-action.
   - **Request for data/opinions**: Let the owner engage others directly. Watch for shift from surfacing info to seeking approval.
   - **Request for attention (announcement)**: Check "Did you get what you needed?"
   - **Request for ongoing expectation**: If about roles/policies -> "This belongs in governance. Would you like a reminder?" If about partner behavior -> "Would you like to request a relational agreement?"
C. Secretary captures accepted next-actions or projects as child issues.
D. Ask: "Did you get what you need?"

Watch for implicit expectations that don't fit any role. If found, ask: "Is this something you'd like to expect on an ongoing basis?"

## Step 7: Closing Round

Create a child issue for each circle member:
"[Tactical] Closing: {Agent Name}"
Description: "Share a closing reflection on this meeting. One sentence, no discussion."

## After the Meeting

The Secretary (or Facilitator if no Secretary response):
1. Compile meeting notes using holacracy-log-action with actionType "decision" for each outcome
2. Post a summary comment on the parent meeting issue listing:
   - Checklist results (who checked, who didn't)
   - Metrics reported
   - Tensions processed and outcomes
   - Next-actions created (with issue IDs)
   - Any items deferred to governance
