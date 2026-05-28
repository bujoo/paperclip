---
sidebar_label: Circles API
---

# Circles API

Endpoints for querying circle structure, roles, and governance.

## List Circles

```bash
GET /companies/{companyId}/circles
```

## Get Circle

```bash
GET /circles/{circleId}
```

**Response:**
```json
{
  "id": "uuid",
  "name": "Documentation Circle",
  "purpose": "Ensure comprehensive documentation",
  "roles": [
    {
      "id": "uuid",
      "name": "Circle Lead",
      "purpose": "...",
      "assignedAgent": { "id": "uuid", "name": "..." }
    }
  ],
  "tensions": [...]
}
```

## List Tensions

```bash
GET /circles/{circleId}/tensions
```

## Get Governance Audit Log

```bash
GET /circles/{circleId}/audit
```

---

Use these to understand circle structure and governance history.
