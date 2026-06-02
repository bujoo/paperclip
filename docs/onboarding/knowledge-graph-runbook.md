# Knowledge Graph Pipeline Onboarding Runbook

> For new engineers: comprehensive guide to audit ingestion, graph transformation, and querying the code-intelligence graph. Answer all three questions without Slack.

---

## Quick Reference

**Three Core Questions Answered:**

1. **How does audit ingestion work?** → See Part 1: code commits → webhook → async audit processing
2. **How does code map to the knowledge graph?** → See Part 2: AST extraction → entity/relationship mapping + walk-through example
3. **How do I query the graph?** → See Part 3: common patterns + Part 5: realistic scenarios

**Key URLs:**
- API docs: `/api/v1/docs`
- Audit status: `/api/audits/{run-id}`
- Graph query endpoint: `/api/graph/query`
- This runbook source: `docs/onboarding/knowledge-graph-runbook.md`

---

## Part 1: Audit Ingestion — How Code Changes Trigger Graph Updates

### 1.1 The Audit Event Flow

When you commit code to the main branch, here's what happens:

```
Code Commit (GitHub)
    ↓
Webhook Event (GitHub → Paperclip)
    ↓
API Handler: POST /webhooks/code-audit
    ↓
Parse & Extract: file diffs, metadata (author, timestamp, repo, branch)
    ↓
Insert to Database: code_audits table (status=pending)
    ↓
Async Worker Pickup: processes audits from queue (FIFO)
    ↓
AST Parsing: extract entities, dependencies, relationships
    ↓
Graph Update: insert nodes + edges into knowledge_graph tables
    ↓
Mark Complete: code_audits.status=success, update timestamps
```

### 1.2 Audit Processing Pipeline

**Step 1: Webhook Reception**
- GitHub sends POST to `/api/webhooks/code-audit` with repo, branch, commit SHA, and changed files
- Handler validates webhook signature (HMAC-SHA256 using stored secret)
- Payload schema: `{ repo, branch, commit, files: [{path, additions, deletions, patch}] }`

**Step 2: Audit Queuing**
- Payload inserted into `code_audits` table:
  - `id`: UUID
  - `repo_id`: linked to git integration
  - `commit_sha`: for traceability
  - `status`: 'pending' (picked up later by async worker)
  - `created_at`: timestamp

**Step 3: Async Processing**
- Background worker (cron or message queue) polls `code_audits WHERE status='pending'`
- For each pending audit:
  1. Fetch full file contents from git (or patch already included)
  2. For each changed file, parse AST (JavaScript/TypeScript via Babel or similar)
  3. Extract entities: classes, functions, types, imports, exports, interfaces
  4. Tag with metadata: line number, scope (public/private), complexity score, dependencies

**Step 4: Entity & Relationship Extraction**
- Entities inserted as `CodeNode` rows:
  - type: 'file', 'function', 'class', 'type', 'interface', 'parameter'
  - name, parent_id (link to file or parent function/class)
  - scope: 'export', 'public', 'private'
  - metrics: cyclomatic_complexity, line_count

- Relationships inserted as graph edges:
  - imports (file → external package)
  - calls (function → function)
  - extends (class → class)
  - implements (class → interface)
  - uses (entity → type)

**Step 5: Mark Success**
- Update `code_audits.status = 'success'`, record `processed_at`
- Mark graph as "current" for this repo/branch

### 1.3 Entry Points for New Engineers

**Q: "How do I trigger an audit?"**
- **A:** Push to main branch → GitHub fires webhook → Paperclip ingests automatically. No manual steps.
  - Check status: `GET /api/audits/{run-id}` returns `{ status, created_at, processed_at, error_message? }`
  - Retry failed audit: `POST /api/audits/{run-id}/retry`

**Q: "What happens if the webhook fails?"**
- **A:** Webhook delivery logged in `github_webhook_logs`. Check `/api/github-logs?status=failed` for missed deliveries.
  - Manual sync: `POST /api/repos/{repo-id}/sync` to force re-audit of all commits in branch

**Q: "How often are audits run?"**
- **A:** Every commit to main. For feature branches, on-demand via `/api/repos/{repo-id}/audit-branch?branch=feature-x`.

**Code Pointers:**
- Webhook handler: `server/src/routes/webhooks.ts` → `POST /code-audit`
- Audit worker: `server/src/workers/audit-processor.ts`
- AST extraction: `server/src/lib/code-parser.ts` (Babel-based for TS/JS)
- Graph insertion: `server/src/services/graph-service.ts` → `insertAuditResults()`

---

## Part 2: Graph Transformation — Code-to-Graph Mapping

### 2.1 Entity Mapping: Code Constructs → Graph Nodes

Each code construct becomes a node in the knowledge graph:

| Code Construct | Node Type | Properties | Example |
|---|---|---|---|
| File | `CodeNode(type='file')` | path, language, line_count | `src/routes/issues.ts` |
| Function | `CodeNode(type='function')` | name, parent_id (file or class), scope, params | `handleIssueCreate(req, res)` |
| Class | `CodeNode(type='class')` | name, parent_id (file), scope, methods[] | `IssueService` |
| Type/Interface | `CodeNode(type='type')` | name, parent_id (file), fields[] | `IssueCreateRequest` |
| Parameter | `CodeNode(type='parameter')` | name, parent_id (function), type_ref | `req: Request` |
| External Package | `ExternalNode(type='package')` | name, version | `express`, `lodash-es` |

### 2.2 Relationship Mapping: How Entities Connect

Edges in the graph encode dependencies and flows:

| Relationship | From | To | Semantics | Example |
|---|---|---|---|---|
| `imports` | File or Function | External Package | "references external code" | `issues.ts` --imports--> `express` |
| `calls` | Function | Function | "invokes at runtime" | `handleIssueCreate` --calls--> `IssueService.create` |
| `extends` | Class | Class | "inherits from" | `AdminController` --extends--> `BaseController` |
| `implements` | Class | Interface | "satisfies contract" | `UserService` --implements--> `IUserService` |
| `uses` | Entity | Type | "references a type" | `handleIssueCreate` --uses--> `IssueCreateRequest` |
| `depends_on` | File | File | "imports another file" | `src/routes/issues.ts` --depends_on--> `src/services/issues.ts` |

### 2.3 Walk-Through Example: HTTP Request Handler

Let's trace how a simple HTTP handler maps to the graph:

```typescript
// File: src/routes/issues.ts
import { Router } from 'express';
import { IssueService } from '../services/issues';

export async function handleIssueCreate(req: Request, res: Response) {
  const svc = new IssueService(req.db);
  const issue = await svc.create(req.body);
  res.json(issue);
}
```

**AST Parsing Step:**
1. Detect imports: `express` (external), `../services/issues` (internal)
2. Extract function: `handleIssueCreate` (async, 2 params: req, res)
3. Extract calls: `IssueService` constructor, `svc.create()`, `res.json()`
4. Extract parameter types: `req: Request`, `res: Response` (both from express)

**Nodes Created in Graph:**

| Node ID | Type | Name | Parent | Scope |
|---|---|---|---|---|
| n_file_1 | file | src/routes/issues.ts | — | — |
| n_fn_1 | function | handleIssueCreate | n_file_1 | export |
| n_param_1 | parameter | req | n_fn_1 | — |
| n_param_2 | parameter | res | n_fn_1 | — |
| n_pkg_1 | package | express | — | external |
| n_class_1 | class | IssueService | src/services/issues.ts | export |
| n_fn_2 | function | create | n_class_1 | public |

**Edges Created:**

| Source | Relation | Target | Meaning |
|---|---|---|---|
| n_file_1 | imports | n_pkg_1 | issues.ts imports express |
| n_file_1 | depends_on | src/services/issues.ts | issues.ts imports IssueService |
| n_fn_1 | calls | n_class_1 (constructor) | handleIssueCreate instantiates IssueService |
| n_fn_1 | calls | n_fn_2 | handleIssueCreate calls IssueService.create |
| n_param_1 | uses | `Request` (type) | req parameter typed as Request from express |
| n_param_2 | uses | `Response` (type) | res parameter typed as Response from express |

**Graph Visualization (simplified):**

```
┌─ express (pkg)
│  ├─ Router
│  ├─ Request (type)
│  └─ Response (type)
└─ issues.ts (file)
   ├─ imports: express
   ├─ depends_on: services/issues.ts
   └─ handleIssueCreate (fn, export)
      ├─ param: req (uses Request)
      ├─ param: res (uses Response)
      └─ calls: IssueService.create()
         └─ IssueService (class, in services/issues.ts)
            └─ create() (method)
```

### 2.4 References: Mapping Logic

- **Grove, High-Output Management, Ch. 3: Delegation**
  - "Delegator and delegatee must share a common information base." — The graph IS that shared base for engineers.
  - "Monitor at the lowest-added-value stage." — Engineers trace bugs fastest when they see the full call chain upfront.
  - Task-relevant maturity: new engineers benefit from detailed call graphs; experts skip to affected files.

- **Holacracy v5 Constitution: Governance & Accountability**
  - Each file/service can own explicit accountability within the graph (e.g., "IssueService owns issue creation logic").
  - When a tension arises (e.g., "IssueService has too many responsibilities"), the graph lets you see which roles/teams depend on each method.
  - Governance decision: split into two classes → update graph, re-run audit → cascade changes visible to all engineers.

---

## Part 3: Query Patterns — Common Lookups

### Pattern 1: Find All Callers of a Function

**Question:** "What code paths call `IssueService.create()`?"

```graphql
MATCH (caller:Function)-[:calls]->(target:Function {name: "create"})
WHERE target.parent.name = "IssueService"
RETURN caller.name, caller.path, caller.scope
ORDER BY caller.path
```

**Expected output:**
```
caller_name              | caller_path                | scope
─────────────────────────┼──────────────────────────────┼────────
handleIssueCreate        | src/routes/issues.ts       | export
migrationRunnerV2        | src/migrations/audit.ts    | private
testIssueCreation        | src/__tests__/issues.test.ts | private
```

**Use case:** Debugging a bug in `create()` → impact 3 locations.

### Pattern 2: Dependency Chain Analysis

**Question:** "What's the full import chain from this file to external packages?"

```graphql
MATCH path = (file:CodeNode {path: "src/routes/issues.ts"})
      -[:imports|calls|depends_on*]->(external:ExternalNode)
WHERE external.type = "package"
RETURN file.path, 
       [r IN relationships(path) | type(r)] as edge_types,
       external.name,
       length(path) as hops
ORDER BY hops DESC
```

**Expected output:**
```
file_path             | edge_types               | package_name | hops
──────────────────────┼──────────────────────────┼──────────────┼─────
src/routes/issues.ts  | [imports]                | express      | 1
src/routes/issues.ts  | [depends_on, calls]      | pg           | 2
src/routes/issues.ts  | [depends_on, calls, uses]| joi          | 3
```

**Use case:** "We're upgrading Express. Which files need testing?" → Answer: 1 direct, N indirect via service calls.

### Pattern 3: Role-to-Code Mapping (Holacracy Integration)

**Question:** "Which roles own or depend on changes to the audit pipeline?"

```graphql
MATCH (role:Role)-[:owns_code]->(code:CodeNode {path: "src/workers/audit-processor.ts"})
RETURN role.name, role.circle, role.accountabilities
UNION
MATCH (code:CodeNode {path: "src/workers/audit-processor.ts"})
      -[:called_by]->(caller)-[:owned_by]->(role:Role)
RETURN role.name, role.circle, caller.name as dependent_code
```

**Expected output:**
```
role.name       | circle       | accountabilities / dependent_code
────────────────┼──────────────┼──────────────────────────────────
Audit Lead      | Engineering  | audit-processor.ts, code-parser.ts
Backend Engineer| Engineering  | routes/webhooks.ts
```

**Use case:** Before deploying audit changes, flag impacted roles → invite to code review.

### Pattern 4: Impact Analysis for Deprecated Dependencies

**Question:** "We're removing `lodash-es`. What code breaks?"

```graphql
MATCH (pkg:ExternalNode {name: "lodash-es"})
MATCH (code:CodeNode)-[:imports]->(pkg)
MATCH (code)<-[:calls]-(caller:CodeNode)
RETURN code.path, pkg.name, 
       collect(distinct caller.path) as callers,
       length(collect(caller)) as impact_count
ORDER BY impact_count DESC
```

**Expected output:**
```
code.path                      | pkg.name   | callers                       | impact_count
────────────────────────────────┼────────────┼────────────────────────────────┼──────────────
src/lib/array-utils.ts         | lodash-es  | [routes/issues.ts, ...]       | 5
src/lib/object-utils.ts        | lodash-es  | [services/issues.ts, ...]     | 3
src/lib/validation.ts          | lodash-es  | [routes/issues.ts, middleware]| 2
```

**Use case:** Prioritize refactoring — highest-impact utilities first.

---

## Part 4: Key Reference Links

### Grove: High-Output Management
- **Chapter 3: Delegation Model**
  - Core principle: "Delegator and delegatee must share common information base and operational ideas."
  - Application: Knowledge graph = shared base. Code structure + dependencies = operational ideas.
  - Monitoring: "Monitor at lowest-added-value stage." → Check graph for new dependencies before they cascade.
  - Task-relevant maturity: Monitoring frequency should decrease as engineer grows familiar with domain.

### Holacracy v5 Constitution
- **Governance & Tension Processing**
  - Tensions = "gap between what is and what could be." Code changes surface tensions (e.g., "this module is now responsible for too much").
  - Governance Process: When a tension is raised, it's resolved by refining role definitions and accountabilities.
  - Application: Graph queries can reveal tensions (e.g., "Function X is called by 12 roles → should be its own service").

- **Explicit Roles & Accountabilities**
  - Each role has explicit accountabilities. Code ownership can mirror role accountability.
  - Example: "IssueService" is owned by "Backend/Issue Lead role" with accountability for "issue creation + retrieval."
  - When a new feature requires changes to IssueService, notify the owning role's circle lead.

---

## Part 5: Realistic Query Scenarios

### Scenario 1: New Engineer Debugging a Bug in Audit Pipeline

**Context:** You're a fresh hire. Someone reports: "Audits are creating duplicate graph nodes for some files."

**Steps:**

1. **Locate the bug:**
   ```
   Question: "What code processes audits and creates nodes?"
   Answer: src/workers/audit-processor.ts → src/services/graph-service.ts
   ```

2. **Query the call chain:**
   ```graphql
   MATCH (file:CodeNode {path: "src/workers/audit-processor.ts"})
         -[:calls]->(service)
   WHERE service.path LIKE "src/services/graph%"
   RETURN file, service, service.methods
   ```
   Output: `audit-processor.ts` calls `graph-service.insertAuditResults()` and `graph-service.deduplicateNodes()`.

3. **Trace the bug:**
   - Check `deduplicateNodes()`: Does it use a unique key? (e.g., `(file_path, function_name, scope)`)?
   - Look at test file: `src/__tests__/graph-service.test.ts` → search for duplicate-related tests.
   - Compare with similar services: `src/services/user-service.ts` — how do they handle duplicates?

4. **Fix and test:**
   - Update deduplication logic in `graph-service.ts`.
   - Run: `npm test -- src/__tests__/graph-service.test.ts`.
   - Manually audit a small repo: `POST /api/repos/test-repo/sync`.
   - Check: `GET /api/audits/{run-id}` — status should be 'success', no duplicate nodes.

**Expected outcome:** Engineer isolated bug to 1-2 functions in ~30 min using graph queries. No Slack needed.

---

### Scenario 2: Planning a Feature (Holacracy + Code)

**Context:** PM requests: "Add a feature: 'Automatically flag over-complicated functions' (cyclomatic complexity > 10)."

**Steps:**

1. **Understand existing code:**
   ```graphql
   QUERY: Find where cyclomatic_complexity is currently calculated.
   MATCH (node:CodeNode)-[:has_metric]->(metric {name: "cyclomatic_complexity"})
   RETURN node.path, metric.value
   LIMIT 5
   ```
   Output: Complexity already tracked in graph during audit. Check `src/lib/code-parser.ts` for calculation logic.

2. **Plan the feature:**
   - Feature logic: Add query to find `CodeNode WHERE cyclomatic_complexity > 10`.
   - Output: Create an alert + generate sub-issues for each over-complex function.
   - UI: Add dashboard widget to show "Functions to refactor this sprint."

3. **Identify role impacts:**
   ```graphql
   QUERY: Which roles own code flagged as over-complex?
   MATCH (node:CodeNode WHERE node.cyclomatic_complexity > 10)
          -[:owned_by]->(role:Role)
   RETURN role.name, role.circle, count(node) as complex_functions
   ```
   Output: Backend role owns 8, Auth role owns 3. Total: 11 functions.

4. **Raise governance issue:**
   - Create issue: "We're adding complexity flagging. Impacts Backend + Auth circles."
   - Invite Backend Lead + Auth Lead to planning meeting.
   - Decide: Do we flag and alert, or auto-refactor with PR?
   - Update role accountabilities if needed (e.g., "Backend role: respond to complexity alerts within 1 sprint").

5. **Execute:**
   - Code the feature in `src/services/graph-service.ts` → new method `findOverComplexFunctions()`.
   - Add API endpoint: `GET /api/graph/complex-functions?threshold=10`.
   - Create dashboard issue per role.

**Expected outcome:** Feature planned + roles aligned + no surprises during implementation.

---

### Scenario 3: Dependency Deprecation & Impact Analysis

**Context:** Security team wants to deprecate `lodash-es` (known vulnerability). It's used by many services.

**Steps:**

1. **Find all usages:**
   ```graphql
   MATCH (pkg:ExternalNode {name: "lodash-es"})
   MATCH (file:CodeNode)-[:imports]->(pkg)
   MATCH (file)<-[:called_by]-(dependent:CodeNode)
   RETURN file.path, 
          collect(distinct dependent.path) as callers,
          length(collect(distinct dependent.path)) as impact_count
   ORDER BY impact_count DESC
   ```
   
   Output:
   ```
   src/lib/array-utils.ts (called by 12 files)
   src/lib/object-utils.ts (called by 8 files)
   src/lib/validation.ts (called by 5 files)
   ```

2. **Prioritize replacements:**
   - High impact: `array-utils.ts` — replace lodash with native Array methods.
   - Medium impact: `object-utils.ts` — evaluate using `structuredClone` or custom implementation.
   - Low impact: `validation.ts` — replace lodash with Joi library (already a dependency).

3. **Create sub-issues per file:**
   ```
   [ISSUE] Replace lodash in array-utils.ts (high priority, 12 dependents)
   [ISSUE] Replace lodash in object-utils.ts (medium priority, 8 dependents)
   [ISSUE] Replace lodash in validation.ts (low priority, 5 dependents)
   ```

4. **Assign + track:**
   - Assign each issue to an engineer based on code ownership.
   - Update each sub-issue: "After merge, re-run audit to verify no remaining lodash imports."
   - Aggregate dashboard: "Lodash migration: 3/3 files updated, audit clean, deprecation complete."

5. **Verification:**
   ```graphql
   MATCH (pkg:ExternalNode {name: "lodash-es"})
   MATCH (file:CodeNode)-[:imports]->(pkg)
   RETURN count(file) as remaining_lodash_imports
   ```
   Expected: 0 after all PRs merged.

**Expected outcome:** Large refactor de-risked by breaking into small, tracked items. Engineers see impact upfront.

---

## Part 6: Troubleshooting

### Audit Failed: "Invalid AST"

**Problem:** You see `{ status: 'error', error_message: 'Invalid AST for src/routes/issues.ts' }`

**Debug:**
1. Check file syntax: `npm run lint -- src/routes/issues.ts`
2. If invalid TypeScript, fix syntax errors first.
3. If valid, check AST parser: `src/lib/code-parser.ts` — update Babel config if needed.
4. Retry: `POST /api/audits/{run-id}/retry`

### Graph Query Times Out

**Problem:** Complex query (e.g., 10+ hops) hangs.

**Optimize:**
1. Add filters: `WHERE cyclomatic_complexity > 5` (reduce result set).
2. Use `LIMIT 100` to cap output.
3. Consider breaking into smaller queries.
4. Check indexes: `GET /api/graph/indexes` — ensure path/name are indexed.

### New Files Not Appearing in Graph

**Problem:** You commit a file but `GET /api/graph/files/{path}` returns 404.

**Debug:**
1. Verify webhook fired: `GET /api/github-logs?file_path={path}` — should show recent event.
2. Check audit status: `GET /api/audits?repo_id=...` — is there a pending audit?
3. If pending for >5min, check worker: `GET /api/workers/status` → is audit processor running?
4. Force sync: `POST /api/repos/{repo-id}/sync`

### Duplicate Nodes in Graph

**Problem:** `MATCH (n:Function {name: "create"}) RETURN count(n)` returns 2 instead of 1.

**Debug:**
1. Check deduplication: `GET /api/graph/config` — is deduplication enabled?
2. Query duplicates: `MATCH (n:Function {name: "create"}) RETURN n.id, n.parent, n.path`
3. If duplicates are in different parents (different classes both have `create()`), this is expected.
4. If truly duplicate, check audit timestamp — one may be from stale run.
5. Manual cleanup: `POST /api/graph/deduplicate` (rebuilds from canonical audit log).

---

## Appendix: API Reference

### Audit Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/audits/{run-id}` | Get audit status + results |
| POST | `/api/audits/{run-id}/retry` | Retry failed audit |
| POST | `/api/repos/{repo-id}/sync` | Force full repo audit |
| GET | `/api/github-logs?status=failed` | List failed webhook deliveries |

### Graph Query Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/graph/query` | Execute GraphQL query |
| GET | `/api/graph/files/{path}` | Fetch node for file |
| GET | `/api/graph/functions/{name}` | Find all functions by name |
| GET | `/api/graph/dependencies/{file-path}` | Trace dependencies for a file |
| POST | `/api/graph/impact-analysis?package={name}` | Deprecated dependency analysis |

### Docs + Help

| Resource | URL |
|---|---|
| API docs (OpenAPI/Swagger) | `/api/v1/docs` |
| This runbook | `/docs/onboarding/knowledge-graph-runbook.md` |
| GitHub webhook logs | `/admin/github-logs` |
| Graph index status | `/admin/graph-indexes` |

---

## Glossary

- **Audit**: Process of parsing code changes and extracting entities + relationships.
- **AST**: Abstract Syntax Tree — parsed representation of code structure.
- **CodeNode**: Vertex in graph representing a code entity (file, function, class, etc.).
- **ExternalNode**: Vertex for external packages (e.g., npm dependencies).
- **Graph Edge**: Relationship between nodes (imports, calls, extends, etc.).
- **Tension** (Holacracy): Gap between current state and desired state, driver for governance.
- **Role Accountability** (Holacracy): Explicit promise a role makes (e.g., "Backend role: maintain IssueService quality").

---

**Last Updated:** 2026-06-02  
**Maintained By:** Researcher (initial draft) + Doc Lead (publication)  
**Version:** 1.0  
**Status:** Ready for new hire onboarding
