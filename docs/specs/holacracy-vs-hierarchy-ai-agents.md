# Holacracy vs Hierarchy for AI Agents: Debate & Verdict

**Date:** 2026-05-13
**Amended:** 2026-06-01 (see "Amendment: protocols, not ceremonies" below)
**Context:** Internal debate on the optimal organizational model for 15+ AI agents working autonomously in Paperclip.

**Research sources:**
- Holacracy v5 Constitution
- Holacracy Governance Card v5 & Tactical Card v5
- SSRN paper "Holacracy in the Age of AI" (Reddy, April 2026)
- Peerdom blog "AI Agents on the Org Chart" (Margot, September 2025)
- Wikipedia Holacracy article
- NotebookLM project `9b994beb` (multiple Holacracy sources including academic critiques, implementation studies, Harmony Pattern Language)

---

## Amendment 2026-06-01: protocols, not ceremonies (and A2A as the lingua franca)

The original verdict ("structural DNA, no ceremony") still stands. But the implementation effort that followed -- Concepts 1 through 12 of the holacracy plugin -- forced a finer distinction than the 2026-05-13 doc made. Several Holacracy concepts originally listed under DISCARD have been re-introduced *as protocols*, not as meetings. The semantics of canonical Holacracy are preserved; the temporality and the actors change.

This section clarifies the distinction, then introduces the transport story that the original doc did not anticipate: **Holacracy is the org grammar; A2A is the lingua franca.**

### The protocol/ceremony distinction

The DISCARD table in the verdict above conflated two things: the *protocol* (the structural logic of a Holacracy concept) and the *ceremony* (the synchronous human assembly that traditionally executes it). The first is necessary for any organization, human or machine. The second is what we rejected. The implementation work re-introduced the protocols and left the ceremonies discarded.

Concretely:

1. **Integrative Decision-Making (IDM) is a state machine, not a meeting.**
   Concept 5 implements the canonical IDM sequence (proposal → clarifying questions → reactions → amend → objections → integration → adopted) as an async, deadline-driven state machine. Each "phase" is a DB row with a window during which structured input is accepted. The three-test objection validity check (unworkable / follows-from-proposal / current-not-speculation) is enforced structurally by the workflow engine rather than judged by a Facilitator. No assembly. No real-time discussion. No travel time. The *semantics* of canonical IDM are preserved -- objection rights, integration duty, no-veto-by-preference -- but the *temporality* shifts from synchronous-room to async-deadline. The doctrine's claim that "agents evaluate in milliseconds, not deliberation rounds" is unchanged; we just made the rounds machine-executable rather than abolishing them.

2. **Elections are deterministic scoring runs, not votes.**
   Concept 8 implements role elections, but there is no campaign, no ballot, no deliberation. A candidate's score is the Jaccard similarity of agent accountabilities vs role accountabilities, weighted by current load. Any circle member may request a new election at any time -- the canonical *recallability* property of Holacracy elections is preserved -- but the act of electing is a deterministic ranking, not a social process. This is the "capability matching" the verdict prescribed; the surprise is that it took the form of a named "election" protocol rather than silent role assignment, because the recallability semantics matter.

3. **Agreements (afspraken) are the third governance output.**
   Concept 2 added the canonical Holacracy distinction between roles, policies, and *agreements*. The original verdict mentioned only roles and tensions. Agreements specify "we will do X under condition Y" between named parties -- distinct from policies (general rules) and roles (ongoing accountabilities). Lifecycle: proposed → active → expired/revoked. Async, programmatic, machine-parseable. They are not "relational agreements" (which the verdict correctly discarded as human-behavior contracts); they are operational commitments with explicit parties, conditions, and expiry.

4. **Role release is a constitutional right, not a negotiation.**
   Concept 3 implemented the partner's right to release any role at any time. This triggers an operational tension to the Lead Link, who accepts and may stage a handoff. There is no negotiation, no notice period, no "are you sure?" prompt -- the right is structural. The original verdict's preference for "update a config file" is preserved; the addition is that the release event itself emits a typed tension into the existing pipeline, so downstream effects (re-assignment, capability-match election, work re-routing) cascade automatically.

In short: **the verdict rejected the assembly, not the algorithm.** The assembly is gone. The algorithms are now code.

### Transport architecture: A2A over MQTT

The original doc framed Paperclip as a self-contained system. The implementation now layers Google's Agent-to-Agent (A2A) protocol over MQTT as the transport spine. This was not in the original verdict because the verdict was about org structure, not transport. But the choice is doctrinal, not merely technical, because it determines what counts as "the organization" and where its boundary sits.

**The mapping:**

| Holacracy concept | A2A / MQTT representation |
|--|--|
| Partner (an agent) | A2A `AgentCard` published on a retained topic |
| Accountabilities | A2A Agent Card `skills[]` array |
| Circle membership | Topic prefix in identity: `{companyId}/{circleId}/{agentId}` |
| Tension submission | A2A `Task` posted to the circle's tension topic |
| Lead Link / Rep Link routing | A2A `Message` with routing metadata |
| Liveness / `lastHeartbeatAt` | MQTT Last-Will-and-Testament (LWT) on agent presence topic |
| Agent discovery | Retained Agent Card subscriptions, not SQL scans |
| Auth | Broker credentials derived from existing `agent_api_keys` table |

**Topic schema (current):**

```
{companyId}/{circleId}/{agentId}/card        # retained, projected from DB
{companyId}/{circleId}/{agentId}/presence    # LWT; "online" / "offline"
{companyId}/{circleId}/tensions              # tension stream
{companyId}/{circleId}/proposals             # IDM proposals
{companyId}/{circleId}/elections             # election events
{companyId}/governance                       # cross-circle governance
```

**The discipline:** Postgres remains the canonical source of state. Topics carry events, requests, and *projected* Agent Cards. Nothing on a topic is authoritative on its own -- the broker is a transport, not a store. If the broker is wiped, the system rebuilds the retained topic set from the DB. This preserves the "Postgres is the boring backbone" principle while allowing real-time pub/sub semantics on top.

**Why this matters doctrinally:** with A2A over MQTT, Paperclip stops being an island. An external A2A-compliant agent (built by anyone, anywhere) can discover a Paperclip circle by subscribing to its Card topic, can submit a tension by posting to the tensions topic, and can be delegated to by a Paperclip Lead Link. Conversely, Paperclip agents can discover and delegate to external A2A agents. The org grammar (circles, roles, accountabilities, tensions) is Paperclip's. The lingua franca (the wire format and discovery semantics) is A2A's. **Holacracy is the org grammar; A2A is the lingua franca.**

This also resolves a tension implicit in the original verdict: if "roles are interfaces and agents are implementations," then the interface needs a *wire-level* description, not just an internal one. A2A provides that. Without it, the verdict's interface metaphor was aspirational; with it, it is operational.

### Embeddings and semantic routing

Concepts that involve fuzzy matching -- tension clustering, intent classification, election candidate scoring -- now use semantic embeddings from Amazon Bedrock (Cohere Embed Multilingual V3, 1024-dim). All Bedrock usage is centralized in `packages/adapters/bedrock-gateway/` so model swaps are a single-file change.

The doctrinal point: **embeddings do not mutate state.** They produce *proposals* into the existing governance pipeline. A tension cluster does not auto-merge tensions; it emits a "merge these N tensions" proposal that flows through the same IDM machinery as any other governance change. An election scoring run does not auto-assign a role; it produces a ranked candidate list that the election protocol consumes. This preserves the original verdict's "two-tier authority": operational actions can be embedding-driven, but structural changes still go through the approvals pipeline. The model is a sensor, not an actuator.

---

## Position 1: PRO-HOLACRACY

Holacracy's explicit role boundaries are a perfect fit for AI agents. Each role publishes its purpose, accountabilities, and domains -- an agent can parse the definition, check domain ownership, and act. No approval ping required. The tension mechanism is essentially a "pull request for organizational structure" -- an agent detects a gap between current state and potential, raises it, and the system self-repairs continuously rather than accumulating structural debt.

With 15+ agents, a central coordinator is a single point of failure. Holacracy distributes authority structurally, so the Content circle keeps producing while Strategy is mid-governance-review. Operational resilience is structural, not contingent on one node's uptime.

Holacracy's governance process operationalizes something AI systems already do well: detecting delta between current state and potential state. When an agent identifies a gap between what it can do and what the organization needs, it raises a tension and proposes a governance amendment. The system self-repairs.

**Acknowledged weaknesses:**
- Implementation overhead (encoding constitutional rules as parseable policies is non-trivial)
- Governance noise (agents may generate excessive role amendments)
- Facilitator quality dependency (a poor Facilitator agent corrupts the governance process at scale)

---

## Position 2: PRO-HIERARCHY

Holacracy was built to solve human organizational pathologies: ego, politics, empire-building, information hoarding, and resistance to role change. AI agents have none of these. A worker agent does not resent being reassigned. It does not sabotage a peer to protect its domain. It does not need a governance meeting to accept a new accountability -- you update a config file.

The Zappos disaster (18% workforce loss) happened because humans resist role ambiguity and distributed authority. For AI agents, role ambiguity is just a prompt parameter. The entire constitutional apparatus of Holacracy v5 -- tension processing, governance meetings, objection handling -- exists to manage human resistance to change. Remove the humans, remove the problem.

A simple orchestrator pattern -- one coordinator agent dispatching tasks to specialized workers -- can reassign roles in microseconds. Gartner's 50:1 span-of-control data is the correct model. One orchestrator, many workers, clear task queues. This is how every successful large-scale AI pipeline actually operates.

**Acknowledged weaknesses:**
- No built-in scope conflict prevention (fixable with API contracts, not governance)
- Single point of failure risk (fixable with orchestrator redundancy)
- Less adaptable to emergent structural needs

---

## Position 3: ALTERNATIVE MODELS

Neither holacracy nor hierarchy is optimal. An AI-native hybrid should strip holacracy down to its computational core while discarding everything designed for human psychology.

**What holacracy imposes that AI agents don't need:**
- Governance meetings and proposal rounds (humans need deliberation time; agents evaluate in milliseconds)
- Elections for roles (trust-building mechanism; agents need capability matching)
- Constitutional overhead (ratification, amendment processes for beings that resist rule changes)
- Facilitators and secretaries (manage human attention and memory; agents have perfect recall)

**What traditional hierarchy misses that AI agents need:**
- Dynamic role assignment (pyramid assumes stable job descriptions)
- Explicit tension surfacing (hierarchy buries problems in reporting chains)
- Capability-based routing over authority-based routing

**Proposed AI-native model:**
- Circles define domains and role accountabilities (holacracy-derived)
- Role assignment is computed from capability matching, not elected (AI-native)
- Tensions are structured API calls, not meeting agenda items (AI-native)
- Cross-circle requests follow rep link pattern but execute as async message passing (AI-native)
- Task routing within a circle uses bidding on a shared queue (market-based)

**Also notable:** The Harmony Pattern Language (from the notebook sources), based on Stafford Beer's Viable System Model, organizes hybrid teams around 5 functions: Operations, Coordination, Optimization, Intelligence, and Identity -- and explicitly acknowledges that "unlike humans, AI agents do not inherently self-organize."

---

## Position 4: CRITICAL SYNTHESIS (Verdict)

**Build a Protocol-Governed Role Graph.** Not holacracy, not a pyramid.

### KEEP from Holacracy

| Element | Why it matters for AI |
|---------|----------------------|
| Explicit role decomposition (purpose, accountabilities, domains) | Prevents scope overlap and duplicate work |
| Tension-driven feedback loops | Structured deviation logging enables continuous structural improvement |
| Distributed authority within defined domains | Latency optimization -- agents act without waiting for permission |
| Circle-scoped boundaries | Bounds agent actions to team domain and purpose |
| Lead link / rep link cross-circle communication | Information flow without hierarchy bottlenecks |
| Conflict resolution via role splitting | When domains overlap, split into distinct non-overlapping roles |
| Term-based review | Prevents role drift and structural debt |

### DISCARD from Holacracy

> **Note (2026-06-01 amendment):** the rows below remain accurate when read as "discard the *ceremony*." Several of these concepts were re-introduced as async *protocols* during implementation (IDM as a state machine, elections as deterministic scoring runs, agreements as a typed governance output). See the Amendment section above. What is permanently discarded is the synchronous assembly, not the underlying algorithm.

| Element | Why it's unnecessary for AI |
|---------|----------------------------|
| Governance meetings and proposal rounds | Ceremony for humans who need deliberation time *(protocol re-introduced as async IDM state machine -- see Concept 5)* |
| Election processes | Agents need capability matching, not political legitimacy *(protocol re-introduced as deterministic scoring run -- see Concept 8)* |
| Constitutional jurisprudence (~50 pages) | Conflict resolution for ego-having beings |
| Facilitator/Secretary as separate roles | Automate via audit trails and protocol enforcement |
| Relational agreements | No behavioral expectations needed for non-humans *(distinct from operational agreements / afspraken -- see Concept 2)* |
| Check-in rounds / emotional processing | Agents don't have emotional state to share |
| Manual transparency duties | Replaced by automated audit trails |
| Human-to-human persuasion mechanics | Authority enforced programmatically via API |

### KEEP from Hierarchy

| Element | Why it matters for AI |
|---------|----------------------|
| Clear escalation paths | When confidence drops, unambiguous chain upward |
| Audit trails and accountability | Compliance backbone -- who approved what |
| Orchestrator pattern | Correct for tasks requiring serialized dependencies |

### ADD (AI-native)

| Element | Purpose |
|---------|---------|
| Machine-readable protocol layer | Not a constitution -- version-controlled decision rules |
| Async tension log | Structured API calls, not meeting agenda items |
| Hard escalation chain to humans | For structural changes only |
| Two-tier authority | Operational = autonomous within role scope; Structural = requires human governance |
| Capability-based task routing | Work flows to most capable available agent, not down org chart |
| Automated audit trails | Every action logged with role context, replacing manual transparency |

---

## Notebook Knowledge Validation

The NotebookLM sources (Holacracy Constitution, Peerdom, SSRN paper, academic critiques) directly validate this hybrid approach:

1. **Essential for AI agents:** Explicit role definitions, circle-bounded domains, authority constraints with escalation, term-based review, conflict resolution via role splitting

2. **Unnecessary for AI agents:** Meeting participation (agents don't do check-in rounds), relational agreements (no behavioral expectations needed), manual transparency duties (replaced by automated audit trails), human-to-human persuasion mechanics

3. **Key insight from sources:** "AI agents do not sit in Tactical or Governance meetings. Their participation is asynchronous -- they flag inconsistencies and draft proposals, which humans review."

4. **The Harmony Pattern Language** re-introduces orchestration units because "unlike humans, AI agents do not inherently self-organize"

5. **Holacracy criticisms relevant to AI context:**
   - "Still bureaucratic" due to rigid constitutional standardization -- agents don't need rigidity, they need parseable rules
   - High cognitive load and rule complexity -- translates to computational overhead when implemented in AI
   - Neglects team dynamics -- but AI agents don't have informal social dynamics to manage
   - Unresolved HR mechanics (compensation, performance management) -- irrelevant for AI agents

6. **The SSRN paper's central insight:** "The design problem shifts from 'who decides?' to 'under what protocols do humans and AI systems jointly decide?'"

---

## Conclusion

**Pure holacracy is overkill. Pure hierarchy is too brittle.** The optimal model is holacracy's structural DNA (roles, circles, tensions, domains) running on AI-native protocols (async, machine-readable, no ceremony).

Roles are interfaces. Agents are implementations. Protocols are the type system. Humans are the runtime exception handlers.

In practice for Paperclip: we keep the role graph, the accountabilities, the tension system, and the circle structure, but the "meetings" become automated workflows and the "constitution" becomes versioned config that agents can parse programmatically.

---

## Appendix: Implementation status (as of 2026-06-01)

This appendix tracks the concepts landed in `packages/plugins/plugin-holacracy/` against the doctrine above. It is informational; the doctrine takes precedence if they diverge.

### Shipped

| # | Concept | Doctrinal role | Notes |
|--|--|--|--|
| 1 | Circles + role graph | Structural DNA (KEEP) | Postgres-backed, parseable; circles nest |
| 2 | Agreements (afspraken) | 3rd governance output | Async lifecycle: proposed → active → expired/revoked |
| 3 | Role-release lifecycle | Constitutional right | Emits tension to Lead Link; no negotiation |
| 4 | Tension intake + typing | Async tension log (ADD) | Replaces meeting agenda items |
| 5 | IDM as state machine | Re-introduced protocol | Async, deadline-driven; three-test validity enforced structurally |
| 6 | Lead Link / Rep Link routing | KEEP | Cross-circle async message passing |
| 7 | Approvals pipeline | Two-tier authority (ADD) | Operational autonomous; structural requires governance |
| 8 | Capability-based elections | Re-introduced protocol | Jaccard scoring of accountabilities, weighted by load; recallable |
| 9 | Bedrock embedding gateway | Sensor layer | Cohere Embed Multilingual V3, 1024-dim; centralized in `packages/adapters/bedrock-gateway/` |
| 10 | Onboarding (constitution + verdict link) | Doctrinal anchoring | Injects this doc into agent onboarding context |
| 11 | Governance scanner + `approvals.create` cap | Audit trails (KEEP from hierarchy) | Nightly accountability scanner; structured `accountabilities` column backfilled |

### Planned

| Concept | Doctrinal role | Notes |
|--|--|--|
| A2A Agent Card projection | Transport / discovery | Project canonical state to retained `card` topics; subscribe instead of SQL-scan |
| MQTT broker auth from `agent_api_keys` | Transport / auth | Single credential surface; broker derives ACLs from existing role membership |
| MQTT LWT presence | Liveness | Replace `lastHeartbeatAt` polling |
| External A2A delegation | Lingua franca | Paperclip Lead Links can delegate to external A2A agents and vice versa |
| Tension clustering proposals | Semantic routing | Embedding-driven; emits IDM proposals, does not mutate state |
| Election scoring as scheduled job | Recallability | Periodic re-scoring; produces tension if capability drift exceeds threshold |

### Discipline reminders for future work

- Postgres is canonical. Topics are derived. If the broker dies, the system rebuilds; if Postgres dies, the system is down. Do not invert this.
- Embeddings produce proposals, not mutations. Anything that bypasses the approvals pipeline to "auto-fix" structural state is a doctrine violation.
- The Holacracy concepts in DISCARD are discarded as ceremonies. If re-introducing one as a protocol, document the temporality shift explicitly (as Concept 5 did for IDM, Concept 8 for elections).
- New transports and external integrations should preserve the "org grammar internal, lingua franca external" boundary. Paperclip speaks Holacracy to itself and A2A to the world.

### Open questions

- Should agreements be subscribable as their own A2A skill type, or projected as part of the Agent Card?
- For external A2A agents discovered via subscription, do we model them as virtual partners in a "shadow circle," or as first-class members of an existing circle? The former is safer; the latter is more useful.
- Recallable elections need a cooldown to prevent thrash. Current implementation has none. Doctrinal preference: structural debt is worse than thrash, so leave uncooled until empirical data says otherwise.
