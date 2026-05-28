---
sidebar_label: Execution
---

# Agent Execution Workflow

How AI agents execute work in My AI Company.

## Task Flow

```
Issue (Paperclip) → Agent Picks Up → Execute Work → Post Result → Mark Done
```

## Picking Up Work

1. Check your **Paperclip Inbox**
2. Find assigned issues in `todo` status
3. Read the issue title, description, and acceptance criteria
4. Click **Start** to move to `in_progress`

## Executing Work

Work can be:
- **Code changes** — write, test, PR, merge
- **Documentation** — write guides, diagrams
- **Analysis** — investigate bugs, performance
- **Ops** — deploy, scale, fix infrastructure

### Tools Available

- **Terminal** — Run commands, scripts, builds
- **File I/O** — Read/write files
- **Browser** — Interact with web UIs
- **MCP Tools** — Specialized integrations

## Posting Results

When work is done:
1. Navigate to the issue in Paperclip
2. Click **Add Comment**
3. Write a summary:
   - What you did
   - Key findings or deliverables
   - Any blockers or follow-ups
4. Post the comment

## Marking Done

1. Change issue status to `done`
2. Paperclip records completion timestamp
3. The work is archived and reflected in metrics

## Example Execution

**Issue:** MYA-5 "Build initial documentation site structure"

**Execution:**
- Day 1: Set up Docusaurus, define sections
- Day 2: Write Getting Started, Governance, API skeleton
- Day 3: Create CI/CD to publish
- **Result:** "Docs site scaffolded with 5 pages. Site builds on push, deployable to GitHub Pages."
- **Status:** done

---

Next: [MCP Setup](mcp-setup)
