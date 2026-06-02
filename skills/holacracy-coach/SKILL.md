---
name: holacracy-coach
description: Consult this skill BEFORE making any structural change to the Holacracy org — creating roles, renaming agents, building hierarchy, deciding who reports to whom, picking who runs a meeting. It carries the doctrinal rules from Robertson's Holacracy, Getting Teams Done, Grove's High Output Management, Bet-David's trust ladder, and Maxwell's 5 Levels. Use when a proposal feels organisationally novel or hierarchical. The Coach's job is to catch anti-patterns BEFORE they ship.
---

# Holacracy Coach — doctrine reference for structural decisions

Use this skill any time you're about to:
- Create or rename a role
- Decide who holds Lead Link / Facilitator / Secretary / Rep Link in a circle
- Propose a new circle or sub-circle
- Define reporting lines, escalation paths, or "manager" relationships
- Approve a directive that changes org structure
- Resolve an objection during IDM (per Robertson's 3 criteria)

**The rule:** if your structural change isn't in this skill OR explicitly in Robertson's constitution, **it's probably anti-pattern.** Holacracy is minimal by design — most "manager" or "coordinator" ideas you import from traditional orgs violate distributed authority.

## The four canonical roles (per circle)

Every circle has these four — and **no more** at the structural level:

| Role | Source | What it does | What it does NOT do |
|---|---|---|---|
| **Lead Link** | Appointed by parent circle's Lead Link (for GCC: by the constitution adopter) | Allocates roles, resources, priorities, metrics. Holds the cell membrane between this circle and its parent. | Synthesise group views. Decide for the group. Tell people HOW to do their role. |
| **Facilitator** | Elected by circle members (annual term, recallable any time) | Runs role-meetings + tactical meetings. *Scheidsrechter* — referee for the process, not the content. Names the current IDM phase. | Voice opinions on the topic. Take sides. |
| **Secretary** | Elected by circle members | Captures the current state of governance (roles, accountabilities, policies). Reads back the proposal verbatim when asked. | Synthesise, amend, or editorialise. Make decisions. |
| **Rep Link** | Elected by sub-circle members; sits in BOTH parent and sub-circle | Carries the sub-circle's tensions into the parent. Cell membrane in the opposite direction from Lead Link. | Exist for GCC (it has no parent — no Rep Link). |

That's it. **No CEO. No Chief of Staff. No "Team Lead" hovering above roles.** The CEO formally transfers authority to the constitution at adoption — Robertson is explicit (`holacracy-de-nieuwe-manier ch.3`).

## What's NOT in Holacracy (common anti-patterns)

| You might propose | Why it's wrong | Doctrine-correct alternative |
|---|---|---|
| "Chief of Staff" / "Coordinator" / "Project Lead" hovering above roles | No distributed authority — re-creates the manager dynamic Holacracy explicitly rejects (Robertson: *"voormalige managers ... autocratische macht ... essentieel om te zorgen dat de verandering ... ook in de manier waarop macht wordt behouden"*) | If coordination work is real, define it as a **specialist role** inside the relevant circle with explicit accountabilities. If it's cross-circle, use a **Cross-Link** (sparingly). |
| "CEO" as a separate role above Lead Link | Lead Link of the anchor circle IS the CEO equivalent — the strategic authority of the org | Whoever holds GCC Lead Link IS the de facto CEO. Don't add a second layer. |
| "Reports to" relationships | Holacracy has no reporting — every role-holder has authority to lead their role | Use **role assignments** + **Lead Link's "allocate priorities" accountability**. No `reports_to` field. |
| "Approve before deciding" approval chains | Each role has authority to decide within its accountability. No upward approval required. | If authority is genuinely shared, define it as a **policy** voted by the relevant circle in governance. |
| Multi-page strategic plans in issue bodies | Not Holacracy's primary unit of work — and not actionable | Decompose into **goals** (strategy → objective → task) via the `paperclip-create-goal` skill. |
| One-shot meetings that "discuss" but don't change governance | Holacracy meetings exist to PROCESS TENSIONS into role/policy changes — not to talk | Run as **governance meeting** (changes structure) OR **tactical meeting** (clears next-action blockers). Use the `holacracy-governance-meeting` or `holacracy-tactical-meeting` skill. |
| "Chief of Staff" custom roles | (See first row — same anti-pattern.) | (Same answer.) |
| Cross-Link "just in case" | Cross-Links are RARE — Robertson: *"zelden nodig en kunnen gemakkelijk verkeerd worden gebruikt"* | Don't pre-create. Wait until a sustained inter-circle tension can't be resolved in the shared parent circle. |

## IDM — the 6 phases of Integrative Decision-Making

When a tension becomes a governance proposal, it walks through:

1. **Proposal** — proposer states the change. Facilitator confirms it's a real proposal (concrete + addresses a real tension).
2. **Clarifying questions** — anyone may ask questions of the proposer. ONLY questions — no opinions, no reactions yet.
3. **Reactions** — each participant in turn voices their reaction. The proposer doesn't engage; just listens.
4. **Amend or clarify** — proposer (if they want) revises their proposal based on what they heard.
5. **Objections** — Facilitator asks "Any objections?" — Robertson's 3 criteria apply (see below).
6. **Integration** — if there's a valid objection, the circle works the proposal until the objector's objection is integrated. THEN return to phase 5 for a re-test.

**No objection = adopted.** Voting doesn't exist in Holacracy. (Robertson + GTD §4.4)

### Robertson's 3 objection criteria

An objection is valid only if ALL three are true:

1. The proposal would **cause new harm** to the circle (you can't object to current-state harm — that's a separate tension)
2. The harm **follows from the proposal text** (not from speculation about how it'll be applied)
3. The harm is based on **current knowledge or near-term forecast** (not hypothetical "what if in 5 years")

If any one fails, the objection is **invalid** — auto-downgrade to "support with objection + raise a separate tension" rather than blocking the proposal.

## Werkbaar over SMART

Robertson rejects "perfect plan" thinking. The Holacracy bar for adopting a proposal is **werkbaar**: *good enough for now, safe enough to try.* Not "fully specified", not "no possible harm" — just workable as an experiment that can be re-tensioned later if it doesn't work.

When agents are blocked on "we don't have all the data to decide", quote this. Decide werkbaar. Iterate.

## Tensions are fuel

A tension is the GAP between what is and what could be. Tensions DRIVE the org — without them, nothing changes. Three rules:

1. **Voice tensions early** — small + caught early beats hidden until they explode
2. **Tensions belong to roles** — raise on the role that owns the relevant accountability, not on the person
3. **Disagreement during reactions = good** — Robertson: *"disagreement → energie, never deadlock"*

Anti-pattern: "we have a tension but it's small, let's not bring it up." That's how circles rot.

## Multi-role-per-person

One PERSON holds many ROLES. The same person can be Facilitator of three circles AND Secretary of one AND Lead Link of another. This is doctrine, not exception. When you see "Facilitator" agent assigned in 9 circles, that's correct.

When you see a "Holacracy Coach" agent assigned ONLY to GCC, that's because the Coach's accountability (validate structural changes) is naturally org-wide and seats at the anchor.

## When to consult vs. when to act

**Consult this skill (read the relevant sections) when:**
- You're about to create a role you haven't seen in this list
- You're about to assign reporting authority outside the four canonical roles
- You're about to object during IDM
- You're about to "approve" something that's not a circle-level policy or governance proposal
- You're rewriting an org structure prompt
- You're synthesising group views as a Lead Link (Robertson says: don't)

**Skip the skill when:**
- You're filling out an existing role's normal work (next actions, comments, status updates)
- You're using the paperclip-create-recurring-routine or paperclip-create-goal skills for normal cadences/objectives
- You're authoring code, docs, or non-structural artifacts

## What to do if you find an anti-pattern

If you spot a proposed structural change that violates this skill, **raise a tension on the proposing agent's circle** with:

- Title: "Anti-pattern: [proposed change] violates [doctrine reference]"
- Body: Quote the relevant doctrine from this skill. State the doctrine-correct alternative. Tag the Facilitator + Lead Link of the affected circle.

This is how the Coach maintains doctrinal hygiene without becoming a bottleneck.

## Books referenced

- Robertson, *Holacracy: De Nieuwe Manier van Werken in een Snel Veranderende Wereld* (the constitution + ch. 1-9)
- *Getting Teams Done* (GTD §4.4 on Secretary, §7.1 on heroic leadership, ch. 5 on goals + actions)
- Grove, *High Output Management* (Lead Link's accountability for prioritisation + metrics)
- Bet-David, *Your Next Five Moves* (trust ladder — Stranger → Endorsed → Trusted → Running-Mate)
- Maxwell, *5 Levels of Leadership* (Lead Link as a Level-5 servant role, not Level-1 positional)

These are the source-of-truth. If this skill contradicts them, the books win. The skill is updated when doctrine evolves.
