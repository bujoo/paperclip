# Doc Query Routing Index v1.0

Purpose: Route incoming doc questions to accountable circle owner. Enables fast resolution + prevents duplication.

Last Updated: 2026-06-02  
Maintained By: Knowledge Curator (Researcher)

---

## Routing Rules (Priority Order)

| Question Pattern | Owner | Circle | Owner ID | Latency SLA |
|---|---|---|---|---|
| "How do I set up local dev?" | Tech Lead (Backend) | Engineering | 322d0092 | 30min |
| "What's the deployment process?" | DevOps Lead | Engineering | 322d0092 | 1hr |
| "How does X API endpoint work?" | Tech Lead (Backend) | Engineering | 322d0092 | 1hr |
| "How do I debug agent config?" | Tech Lead (Backend) | Engineering | 322d0092 | 2hr |
| "What's our onboarding process?" | Onboarding Designer | Documentation | 54b0194c | 30min |
| "What does [role] do?" | Circle Rep | Documentation | 322d0092 | 1hr |
| "How do we make governance decisions?" | Facilitator | Documentation | 4d53f137 | 2hr |
| "Where do I find [feature] docs?" | Doc Lead | Documentation | 1243032c | 30min |
| "Our docs have an error" | Doc Lead | Documentation | 1243032c | 1hr |
| "Which docs are stale?" | Doc Lead | Documentation | 1243032c | 1 day |
| "How do we prioritize features?" | Product Manager | Product | 9adc6c20 | 2hr |
| "What's the roadmap?" | Product Manager | Product | 9adc6c20 | 1hr |
| "How do we measure success?" | Product Manager | Product | 9adc6c20 | 2hr |
| "How do we handle AI updates?" | AI Intelligence Monitor | Learning & Development | 54b0194c | 1hr |
| "What's the knowledge base?" | Knowledge Curator | Learning & Development | 54b0194c | 30min |
| Cross-circle or ambiguous | Doc Lead (fallback) | Documentation | 1243032c | 2hr |

---

## Ownership by Doc Category

### Engineering Docs
**Owner**: Tech Lead (Backend) — 322d0092  
**Circle**: Engineering  
**Docs**:
- `docs/deploy/*` — deployment + infrastructure (AWS, Docker, database, secrets)
- `docs/cli/*` — CLI commands + setup
- `docs/start/architecture.md` — system design
- `docs/adapters/*` — agent adapters (HTTP, Claude, Codex, etc.)
- `docs/agents-runtime.md` — agent execution model
- `docs/onboarding/knowledge-graph-runbook.md` — audit pipeline + graph querying
- API reference (endpoints, models, error codes)

**Query Examples**:
- "How do I deploy to AWS?"
- "What adapters are available?"
- "How does the audit pipeline work?"

---

### Documentation / Knowledge Management Docs
**Owner**: Doc Lead — 1243032c  
**Circle**: Documentation  
**Docs**:
- `docs/governance/*` — governance docs, roles, circles, policies
- `docs/onboarding/*` — onboarding playbooks, decision context
- Doc taxonomy + index
- Stale doc audit results
- Documentation process/standards

**Query Examples**:
- "Where do I find onboarding docs?"
- "What's the documentation standard?"
- "Are these docs current?"

---

### Product / Strategy Docs
**Owner**: Product Manager — 9adc6c20  
**Circle**: Product  
**Docs**:
- `docs/specs/*` — feature specs, architecture decisions
- `docs/plans/*` — roadmap + planning docs
- Feedback + voting process
- Roadmap + priority framework

**Query Examples**:
- "What's the roadmap?"
- "Why was this feature prioritized?"
- "How do we evaluate feature requests?"

---

### Learning & Development Docs
**Owner**: Knowledge Curator / AI Intelligence Monitor — 54b0194c  
**Circle**: Learning & Development  
**Docs**:
- AI research digest + trends
- Knowledge base (NotebookLM)
- Learning paths + onboarding curriculum
- AI ethics + governance guidelines

**Query Examples**:
- "What's new in AI this week?"
- "How do I use the knowledge base?"
- "What's our AI ethics policy?"

---

## Implementation: Routing Workflow

### Step 1: Index Ingestion
When new doc is added/updated:
1. Parse metadata: category, owners (circle + agent), tags
2. Add to routing index: categorize by domain
3. Update this file (manual or auto via script)
4. Alert owner: "Your domain doc was updated"

### Step 2: Question Reception
When question received (Slack, email, ticket):
1. Classify question → routing rules table (above)
2. Route to owner (direct mention or ticket assignment)
3. Log query: track which docs are queried (analytics)
4. Set response SLA (from table)

### Step 3: Tactical Meeting Integration
**Template for Tactical Meeting**:
```
## Doc Queries This Week

- [Query type]: [question] → [owner] → [SLA met? Y/N]
- [Query type]: [question] → [owner] → [SLA met? Y/N]

Analytics:
- Total queries: N
- Avg resolution time: Xmin
- Docs queried (top 5): [list]
- Stale docs detected: [list]
```

### Step 4: Staleness Tracking
Queries reveal stale docs:
- If same question asked 2+ times/week → doc is confusing
- If doc queried >5x/week → likely stale or incomplete
- Monthly: identify top 5 "re-asked" questions, batch fix those docs

---

## Initial Metrics (Baseline)

**Before Routing Index**:
- Doc questions scattered across: Slack (primary), email, issues (few)
- Time to answer: 2-30min (depends on who sees Slack)
- Re-asked questions: ~5-8 per week (estimated)
- Doc staleness discovery: reactive (user complains)

**Target After 4 Weeks**:
- Doc questions centralized: Slack #doc-help channel + routing
- Time to first response: <2min (routed immediately)
- Re-asked questions: 0-2 per week (tracked + fixed)
- Doc staleness discovery: proactive (from query analytics)

---

## Next Steps

1. **Week 1**: 
   - Share routing index with all circles (get acknowledgment)
   - Set up #doc-help Slack channel
   - Brief teams on routing workflow

2. **Week 2**:
   - Route 100% of doc questions using index
   - Collect baseline metrics (latency, re-asked count)

3. **Week 3**:
   - Analyze queries → identify top 5 stale docs
   - Batch fix stale docs (owners responsible)

4. **Week 4**:
   - Review metrics vs targets
   - Refine routing rules based on patterns observed
   - Scale: automated routing (chatbot / doc AI)

---

## Owner Acknowledgment Checklist

Each circle lead + owner should confirm:

- [ ] **Tech Lead (Engineering)**: Accept ownership of deploy + architecture docs (322d0092)
- [ ] **Product Manager**: Accept ownership of roadmap + specs (9adc6c20)
- [ ] **Doc Lead**: Accept ownership of governance + onboarding docs (1243032c)
- [ ] **Knowledge Curator**: Accept ownership of learning + knowledge base (54b0194c)
- [ ] **Circle Rep (Fallback)**: Accept routing for ambiguous cross-circle Qs (322d0092)

---

## Appendix: Query Analytics Schema

Suggested fields for tracking queries:

```json
{
  "query_id": "uuid",
  "timestamp": "2026-06-02T08:40:00Z",
  "question": "How do I deploy to AWS?",
  "asker_agent_id": "54b0194c-...",
  "routed_to_owner": "322d0092-...",
  "owner_response_time_minutes": 12,
  "sla_met": true,
  "doc_links_provided": ["docs/deploy/aws-ecs.md"],
  "is_re_asked": false,
  "resolved": true
}
```

Use this to identify:
- Owner response time trends
- Most frequently queried docs
- Re-asked questions (resolved column = N)
- SLA violations

---

**Maintained By**: Researcher (Knowledge Curator)  
**Review Cycle**: Weekly (Tactical Meeting)  
**Last Revised**: 2026-06-02 08:40:00+04
