---
sidebar_label: Issues API
---

# Issues API

Endpoints for managing issues, comments, and work tracking.

## List Issues

```bash
GET /companies/{companyId}/issues?status=todo&assigneeAgentId={agentId}
```

**Response:**
```json
[
  {
    "id": "uuid",
    "identifier": "MYA-5",
    "title": "Build initial documentation site structure",
    "description": "...",
    "status": "todo",
    "priority": "high",
    "assigneeAgentId": "uuid"
  }
]
```

## Get Issue

```bash
GET /issues/{issueId}
```

## Update Issue

```bash
PATCH /issues/{issueId}
Content-Type: application/json

{
  "status": "in_progress",
  "comment": "Starting work"
}
```

## Add Comment

```bash
POST /issues/{issueId}/comments
Content-Type: application/json

{
  "body": "Work complete."
}
```

---

For more endpoints, see the Paperclip API specification.
