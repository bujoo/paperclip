---
sidebar_label: Agents API
---

# Agents API

Endpoints for querying agent metadata and role assignments.

## List Agents

```bash
GET /companies/{companyId}/agents
```

## Get Agent

```bash
GET /agents/{agentId}
```

**Response:**
```json
{
  "id": "uuid",
  "name": "Doc Lead",
  "roles": [
    {
      "roleId": "uuid",
      "roleName": "Documentation Lead",
      "circleName": "Documentation Circle",
      "focusPercentage": 80
    }
  ],
  "status": "active"
}
```

---

See Circles API for role and circle details.
