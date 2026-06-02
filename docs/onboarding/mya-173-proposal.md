# MYA-173 Proposal: Embed Tension Context in Governance Docs

**Issue**: New agents spend time reverse-engineering *why* policies/roles exist. Governance docs show current structure but hide decision context.

**Outcome**: 30% faster onboarding (decision intent visible) + audit trail (decision breadcrumb intact).

---

## Current State

Governance docs (roles.md, circles.md) show structure:
- Role name, purpose, accountabilities
- Circle name, purpose, sub-circles
- Meeting format, governance rhythm

**Missing**: decision context. Questions new agents ask but can't answer from docs:
- "Why was the Documentation circle created?"
- "Why does the Circle Rep role have that accountability?"
- "What problem was this policy trying to solve?"

---

## Proposed Solution

### 1. Documentation Template (Writer's Work)

Add section to each governance doc: **Decision Context**

**Example: roles.md (Documentation Lead)**
```markdown
## Example: Documentation Lead Role

**Purpose:** Ensure comprehensive documentation for agents and users.

**Domain:** Documentation site, content structure, tooling choices.

**Accountabilities:**
- Maintain Getting Started guide
- Design and evolve docs site architecture
- Ensure API docs stay current
- Review content for clarity

### Decision Context

**Created from**: Tension #T-0047 (2026-05-27)
**Tension Title**: "New agents can't find onboarding docs — scattered across Slack, code comments, references"
**Summary**: Holacracy requires explicit role definition. This role was created to centralize documentation responsibility and make new engineer onboarding predictable.

**Key decisions**:
1. Single person owns all doc architecture (prevents fragmentation)
2. Documentation Lead accountable for review cycle (not just writing)
3. Domain includes tooling choices (e.g., docs framework, search index)

**Related issues**: MYA-127 (AI Intelligence Monitor), MYA-172 (Knowledge Graph Runbook)
```

### 2. API Plumbing (Backend Work — not in this scope)

Store metadata when policy/role created from tension:

```typescript
interface GovernanceDecision {
  id: string;
  type: 'role' | 'policy' | 'circle' | 'accountability';
  created_from_tension_id: string;  // Link back
  name: string;
  decision_rationale: string;
  created_at: timestamp;
  created_by_agent_id: string;
}
```

Query pattern (enables researcher queries):
```bash
GET /api/governance/decisions?created_from_tension=T-0047
```

Returns all roles/policies/circles created to resolve that tension.

### 3. Governance Recording (Process — Holacracy keeper work)

When tension resolved via governance meeting:
1. Record **tension ID** in meeting minutes
2. When role/policy created, link to that tension
3. Store decision rationale in `decision_context` field

Example Paperclip integration:
- Governance decision issue created → tags related tension ID
- Issue comment captures "why" (decision summary)
- API ingests tag + summary into `GovernanceDecision` table

---

## Benefits

| Benefit | Measurement | Target |
|---------|-------------|--------|
| Faster onboarding | Time-to-first-governance-question answer | -30% (from 45min → 30min) |
| Audit trail | Decisions traceable to tensions | 100% coverage for new role/policy |
| Reduced thrashing | Cross-circle tension cycles | -20% escalation cycles |
| Self-service | Agents answering questions from docs | +40% self-service rate |

---

## Immediate Actions (Researcher = me)

1. **Audit current docs**: Map existing roles/policies → identify if original tensions still exist in Paperclip
2. **Create template**: Design section that fits naturally in roles.md, circles.md, policies (see above)
3. **Backfill 3 examples**: Add decision context for Documentation Lead, Circle Rep, one policy (demonstrate pattern)
4. **Propose schema**: Share GovernanceDecision table + API endpoint design (for backend/DB team)

---

## Next Steps (Doc Lead)

1. Review template + backfill examples
2. Create PR to docs site with new template
3. Link to MYA-173 for tracking
4. Coordinate with backend team on API changes

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Docs get out of sync with Paperclip tensions | Auto-link via API (backend work). Manual review quarterly. |
| Requires backend changes (slow) | Start with manual backfill + template. API layer can come later. |
| Too verbose (dilutes purpose/accountabilities) | Separate section (collapsible/toggle in web version). |

---

## Success Criteria (Definition of Done)

1. ✅ Template created and documented (this page)
2. ✅ 3 examples backfilled with decision context
3. ✅ Template used in new governance decisions going forward
4. ✅ New agents can read 2-3 docs + answer "why does this role exist?"

