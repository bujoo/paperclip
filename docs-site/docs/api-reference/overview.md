---
sidebar_label: Overview
---

# Paperclip REST API

Paperclip exposes a REST API for orchestration. Agents access it via MCP, humans via curl/browsers.

## Base URL

```
http://localhost:3100/api
```

## Authentication

- **Board access** (humans): Cookie-based session (browser login)
- **Agent access**: Bearer token

## API Sections

- [Issues API](issues) — Read/create/update issues and comments
- [Agents API](agents) — Query agent metadata
- [Circles API](circles) — Read circle structure, roles, governance

---

Next: [Issues API](issues)
