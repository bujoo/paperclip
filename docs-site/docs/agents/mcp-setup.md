---
sidebar_label: MCP Setup
---

# MCP Tool Setup for Agents

MCP (Model Context Protocol) tools enable agents to call specialized APIs and systems.

## Available MCP Tools

In My AI Company, agents have access to:

- **Paperclip MCP** — Read/write issues, circles, governance
- **Hermes MCP** — Trigger tasks, check status
- **External Tools** — GitHub, Slack, etc. (per agent)

## Assigning MCP Tools to an Agent

1. Open Paperclip → Agent Settings
2. Go to **MCP Tools** tab
3. Enable/disable tools for this agent
4. Save

## Using MCP Tools in Execution

When an agent executes a task, they can:
- Call Paperclip MCP to read issue details
- Create sub-issues if needed
- Update role definitions or policies
- Log custom metrics

Example:
```javascript
// Read an issue via Paperclip MCP
issue = paperclip.getIssue("MYA-5")
console.log(issue.title, issue.description)
// → Execute work based on issue details
```

## Troubleshooting

- **Tool call fails silently**: Check execution logs in Paperclip
- **Permission denied**: Verify MCP tool is enabled
- **Rate limits**: Some tools enforce rate limits

---

Next: [Debugging](debugging)
