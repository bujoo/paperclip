## ContextHub Onboarding: Start Here

**Read in this order. Each step unlocks next.**

### Tier 0: Mission (5 min)
Read company DNA — mission statement, values, governance model.
→ Establishes why we document + what we preserve.

### Tier 1: Architecture (15 min)
1. System overview diagram (architecture-docs/overview.md)
2. Code-intelligence graph concept (product-docs/graph-model.md)
3. Data flow: audit → ingestion → query (architecture-docs/data-flow.md)

→ Unblocks: what you're building.

### Tier 2: Codebase Navigation (20 min)
1. Repo structure (dev-docs/repo-layout.md)
2. Key packages (dev-docs/core-packages.md)
3. Dev environment setup (dev-docs/setup.md)

→ Unblocks: where code lives, how to run it locally.

### Tier 3: Feature-Specific Depth (30+ min)
Pick your circle/role:
- **Engineering**: architecture-docs/extensibility.md → dev-docs/adding-features.md
- **Product**: product-docs/graph-capabilities.md → roadmap.md
- **Documentation**: doc-standards.md → contribution-workflow.md
- **Marketing/Sales**: product-docs/positioning.md → use-cases.md

→ Unblocks: deep work in your domain.

### Tier 4: Integration & Troubleshooting (as-needed)
- API reference (api-docs/reference.md)
- Common errors (dev-docs/troubleshooting.md)
- Cross-circle queries (wiki/faq.md)

---

## Doc Index (Flat Reference)

| Category | Doc | Purpose | Read After |
|----------|-----|---------|------------|
| Foundation | company-dna.md | Mission, values, governance | Tier 0 |
| Architecture | system-overview.md | High-level component diagram | Tier 1 |
| Architecture | graph-model.md | Graph storage, query semantics | Tier 1 |
| Architecture | data-flow.md | Audit → ingestion → query pipeline | Tier 1 |
| Dev | repo-layout.md | Monorepo structure, package boundaries | Tier 2 |
| Dev | core-packages.md | What each package does | Tier 2 |
| Dev | setup.md | Local environment, first run | Tier 2 |
| Dev | adding-features.md | Extension patterns, code style | Tier 3 (Eng) |
| Dev | troubleshooting.md | Common errors, debug workflow | Tier 4 |
| Product | graph-capabilities.md | Feature tour, limitations | Tier 3 (PM) |
| Product | positioning.md | Use cases, competitive angle | Tier 3 (Sales) |
| Product | roadmap.md | Q2/Q3 priorities | Tier 3 (PM) |
| API | reference.md | Endpoint specs, auth | Tier 4 |
| Docs | doc-standards.md | Writing style, structure templates | Tier 3 (Doc) |
| Docs | contribution-workflow.md | PR process for docs | Tier 3 (Doc) |
| Shared | faq.md | Cross-circle questions, answers | Tier 4 |

---

## How to Use This Index

**Onboarding flow (first week):**
1. Skim Tier 0 (context)
2. Read Tier 1 + 2 in order (mental model + practical)
3. Jump to Tier 3 for your role
4. Tier 4 as blockers emerge

**Lookups (after week 1):**
- Use flat index table — search by role, purpose, or category
- Links in each doc point to prerequisites (if you hit unfamiliar concept, backtrack via index)

**Stale docs:** Flag in #docs-feedback or raise tension with Doc Lead (1243032c)

---

**Last updated:** 2026-06-02
**Owner:** Researcher (54b0194c) in Documentation
**Location:** /docs/onboarding-entry-point.md (commit + link from README)