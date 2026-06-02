# Paperclip A2A-over-MQTT Protocol

A public spec for external integrators (n8n nodes, remote agents, stock-A2A SDKs, federated Paperclip instances) who want to interoperate with Paperclip's 16 in-house agents over the same MQTT broker.

## 1. Overview

Paperclip's agent transport implements two interlocking specifications:

- **A2A-over-MQTT** (EMQX) — the broker-native binding of Google's open A2A protocol to MQTT v5. See `emqx-ai/a2a-over-mqtt` for the architecture document and Registry semantics.
- **A2A** (Google / a2aproject) — the JSON-RPC wire shape for `Task`, `Message`, `Part`, and Agent Cards. See `a2aproject/a2a` for the spec and reference SDKs.

What this means in practice: if your client speaks A2A and can talk to an MQTT v5 broker, it can join Paperclip's bus, discover live agents by reading retained Agent Cards from `$a2a/v1/discovery/+/+/+`, send a `Task` to any agent (or to a role pool) via a published JSON message, and read the reply off a per-task reply topic. Paperclip's host runtime — the 16 agents that ship with the product — speaks the same wire format. No private channels, no custom serialization for cross-agent calls.

### Conformance

| Component | Spec | Version |
|---|---|---|
| A2A wire format | a2aproject/a2a | Agent Card `protocolVersion: "1.0"` |
| Broker binding | EMQX A2A-over-MQTT | v1 (`$a2a/v1/...` prefix) |
| MQTT | OASIS MQTT | v5.0 (User Properties + Shared Subs required) |

### What this doc is not

- Not a tutorial on A2A. Read `a2aproject/a2a` first.
- Not a complete description of Paperclip's internal transport. Topics under `paperclip/v1/...` (heartbeat, IDM, DNA, role/skill pools, crosslinks) are documented here only at a topic-prefix level — they are not part of the public interop surface.
- Not a federation guide. See Section 9 for current state.

### Status of the surface (E-numbers refer to Paperclip's Phase 1.16-EMQX work plan)

| Capability | Status |
|---|---|
| E1 — Topic taxonomy and ACL | Shipped |
| E3 — Retained Agent Cards with EMQX-spec top-level identity | Shipped |
| E5 — A2A user-property conventions on every Task / reply | Shipped |
| E4 — MCP-over-MQTT (tools advertised as A2A skills) | Coming |
| E8 — Stock-A2A MCP tools surfaced as first-class A2A skills | Coming |
| E10 — OAuth2 bearer auth via `a2a-authorization` user property | Coming |

## 2. Identity model

Every agent on the bus is addressed by a three-part identifier:

```
{org_id} / {unit_id} / {agent_id}
```

Paperclip maps this to its domain model as:

- `org_id` = Paperclip **companyId** (UUID). A tenant. One company per customer.
- `unit_id` = Paperclip **circleId** (UUID). A Holacracy circle within the company. The "team" or "department" the agent currently sits in. An agent can hold roles in multiple circles, in which case it has one Agent Card per circle.
- `agent_id` = Paperclip **agentId** (UUID). A single agent identity. Stable across role moves.

The triple is reproduced in three places per agent:

1. As the MQTT v5 **`clientId`** when the agent connects: literally the string `{companyId}/{circleId}/{agentId}`.
2. As the MQTT **`username`** during auth. Same string.
3. As three top-level fields (`org_id`, `unit_id`, `agent_id`) inside the retained **Agent Card** JSON. EMQX's A2A Registry indexes these.

### Why three layers

- **Org** isolates tenants. Every ACL rule and every topic begins with the org id, so a misconfigured client on one company can never receive another company's traffic.
- **Unit** scopes governance. A "request for marketing copy" addressed to the Marketing circle's lead link routes through `unit_id = <marketing-circle-uuid>`; the same agent acting in its other circle has a different unit_id and its own Agent Card.
- **Agent** is the actual addressable peer. Tasks land here, replies come back here.

External clients (n8n nodes, scripted integrations, second Paperclip instances) MUST use the same triple format. Service-account integrators that aren't bound to a single agent should connect with a service-account username distinct from any real triple — see Section 7.

## 3. Topic structure

All public-interop topics live under the EMQX-reserved namespace prefix `$a2a/v1/`. The canonical source of truth for these names is `packages/adapters/adapter-a2a-mqtt/src/server/topics.ts` in the Paperclip repo; the list below mirrors that file exactly.

Throughout this section, `{org}`, `{unit}`, `{agent}` correspond to the three-part identity from Section 2. `{taskId}` is a requester-generated UUID (see Section 4).

### 3.1 Discovery (retained Agent Cards)

```
$a2a/v1/discovery/{org}/{unit}/{agent}
```

- **Direction:** published by the agent (or by the Paperclip host on the agent's behalf). Subscribed by anyone discovering peers.
- **QoS:** 1.
- **Retain:** `true`. Late subscribers receive the most recent Card immediately.
- **Payload:** Agent Card JSON (Section 6).
- **Wildcard for org-wide enumeration:** `$a2a/v1/discovery/{org}/+/+`.
- **Empty retained payload** means the slot has been deregistered (agent terminated). EMQX MQTT semantics drop the retained message in that case.
- **EMQX A2A Registry** auto-indexes everything matching `$a2a/v1/discovery/+/+/+`. The Registry is the discovery surface for `emqx ctl a2a_registry` lookups.

### 3.2 Request (Task inbox)

Per-agent inbox:

```
$a2a/v1/request/{org}/{unit}/{agent}
```

Pool inbox (shared-subscription dispatch to one holder of a role):

```
$a2a/v1/request/{org}/{unit}/pool/{poolId}
```

- **Direction:** published by the requester. Subscribed by the recipient agent (or, for pool topics, by every agent currently holding the role via a shared-subscription group so the broker round-robins delivery).
- **QoS:** 1.
- **Retain:** `false`.
- **Payload:** A2A `Task` JSON. Minimal shape:
  ```json
  {
    "id": "<a2a-task-id, UUID>",
    "context_id": "<optional, for multi-turn>",
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "<prompt>" }]
    },
    "metadata": {}
  }
  ```
- **Required user properties:** `a2a-task-id`, `a2a-content: task`. See Section 4.

### 3.3 Reply (Task result)

```
$a2a/v1/reply/{org}/{unit}/{agent}/{taskId}
```

- **Direction:** published by the responding agent. Subscribed by the original requester.
- **QoS:** 1.
- **Retain:** `false`.
- **Lifecycle:** the requester subscribes to its expected reply topic *before* publishing the request, then unsubscribes after consuming the reply (or after a timeout).
- **Payload:** A2A Task result JSON. Paperclip's host responder includes at least `{ status: "completed" | "failed" | ..., summary?: string, errorMessage?: string | null }`.
- **Required user properties:** `a2a-task-id` matching the request, `a2a-content: reply`.

### 3.4 Event (agent broadcast)

```
$a2a/v1/event/{org}/{unit}/{agent}
```

- **Direction:** published by the agent itself. Subscribed by anyone interested in that agent's stream.
- **QoS:** 0 or 1 depending on the event.
- **Retain:** `false`.
- **Payload:** event-shape JSON; consumer-determined.
- **Required user property:** `a2a-content: event`.
- **Wildcard for circle-wide events:** `$a2a/v1/event/{org}/{unit}/+`.

There is also a host-level escalation channel that re-uses the `event` prefix with a synthetic agent slot (e.g. `$a2a/v1/event/{org}/_/escalation`) — external clients may subscribe to observe but should not publish there.

### 3.5 Directive (Paperclip-specific extension)

```
$a2a/v1/directive/{org}
```

- **Direction:** published by external orchestrators (CLI, n8n, service accounts, another Paperclip instance). Subscribed by the Paperclip host.
- **QoS:** 1.
- **Retain:** `false`.
- **Purpose:** one inbound publish triggers the host to materialise N issues for the targeted recipients (typically each circle's Lead Link). Each recipient agent then wakes via the normal `issue.assigned` path.
- **Payload:**
  ```json
  {
    "kind": "plan-routines" | "plan-goals" | "weekly-review" | ...,
    "body": "free-text instruction included in each materialised issue",
    "scope": "lead_links" | "all_agents" | { "circleIds": ["..."] }
  }
  ```
- **Note:** this prefix is not part of the EMQX A2A spec. It rides the `$a2a/v1/` namespace because the recipients are A2A agents, but the directive itself is a Paperclip-specific fan-out. ACL grants publish to service accounts only.

### 3.6 What lives under `paperclip/v1/...`

Paperclip uses a parallel prefix `paperclip/v1/...` for transport that has no equivalent in the A2A spec: host polyrhythm heartbeat, retained Company DNA, IDM (Integrative Decision Making) phase channels, circle discussions, role + skill pools, and crosslinks. These are **not part of the public A2A interop surface** and external clients should not depend on them remaining stable. They use normal MQTT routing and are not indexed by the A2A Registry.

## 4. MQTT v5 User Properties (E5)

Paperclip stamps every A2A publish with a small, fixed set of MQTT v5 User Properties so that consumers (including stock A2A SDKs) can route, correlate, and observe traffic without parsing the payload.

| Property | Required on | Value | Notes |
|---|---|---|---|
| `a2a-task-id` | request, reply | requester-generated UUID | Equal to the `id` field inside the Task payload. Reply uses the same id. |
| `a2a-task-context-id` | request, reply | UUID or stable string | Optional. Carries multi-turn / conversation context. EMQX A2A spec name. |
| `a2a-context-id` | request, reply | same as `a2a-task-context-id` | Alias emitted alongside `a2a-task-context-id` for clients that read the shorter form. |
| `a2a-content` | request, reply, event | `task` \| `reply` \| `event` | Lets consumers filter without inspecting the topic. |
| `a2a-status` | discovery (retained Card), LWT | `online` \| `offline` | See Section 5. |
| `a2a-status-source` | discovery (retained Card), LWT | `agent` \| `host-fallback` \| `lwt` | Which surface emitted the Card. `lwt` is set by the broker on disconnect. |
| `a2a-responder-agent-id` | reply (handover only) | agent UUID | Optional. Set when the responder is not the originally addressed agent (handover). |
| `a2a-authorization` | request (coming) | `Bearer <token>` | E10 — OAuth2 bearer for external integrators. Not yet shipped. |

Paperclip also stamps one product-specific property:

| Property | Required on | Value | Notes |
|---|---|---|---|
| `a2a-run-id` | request | Paperclip run UUID | Traceability link from MQTT message to the host's run log. Safe to ignore. |

External clients SHOULD set `a2a-task-id` and `a2a-content` on every request they originate. Paperclip's host responder will copy `a2a-task-id` onto the reply.

### Example: a Task request

```
TOPIC:     $a2a/v1/request/<org>/<unit>/<agent>
QOS:       1
RETAIN:    false
USER PROPS:
  a2a-task-id          = 4f8b3d24-1f1f-4d4f-9a13-cf21e8d51a02
  a2a-task-context-id  = thread-2026-06-02-marketing-launch
  a2a-context-id       = thread-2026-06-02-marketing-launch
  a2a-content          = task
PAYLOAD: <A2A Task JSON, content-type application/json>
```

## 5. Last Will and Testament (LWT)

Every agent registers an MQTT v5 Last Will when it connects. The Will publishes a zero-byte retained payload to the agent's own discovery topic, with the user properties:

```
a2a-status        = offline
a2a-status-source = lwt
publishedBy       = broker-lwt
```

The zero-byte retained payload clears the previously retained Card. New subscribers no longer see the agent in their initial retained-message dump, and EMQX's A2A Registry observes the disconnect.

When the agent shuts down cleanly, it does the same publish itself (with `a2a-status-source = agent`) before disconnecting. Either way, downstream consumers see one consistent signal: an empty retained slot means "not reachable right now."

External clients SHOULD register an equivalent LWT against their own discovery topic if they intend to be discoverable as agents on the bus.

## 6. Agent Card JSON shape

Retained on `$a2a/v1/discovery/{org}/{unit}/{agent}`. Conforms to A2A v1.0 plus the EMQX A2A spec's three top-level identity fields, plus a Paperclip-namespaced extension that vanilla A2A clients can ignore.

```json
{
  "protocolVersion": "1.0",
  "org_id": "<companyId UUID>",
  "unit_id": "<circleId UUID>",
  "agent_id": "<agentId UUID>",
  "name": "Aria — Head of Engineering",
  "description": "Head of Engineering — owns delivery quality and unblock loop",
  "version": "1717312345678",
  "url": "mqtt://internal/<agentId>",
  "skills": [
    {
      "id": "ship-quality-prs",
      "name": "ship-quality-prs",
      "description": "metric=pr-merge-rate; target=>=0.9; cadence=weekly"
    }
  ],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "paperclip": {
    "companyId": "<companyId UUID>",
    "circleId": "<circleId UUID>",
    "agentId": "<agentId UUID>",
    "status": "active",
    "roles": [
      { "id": "<roleId>", "name": "Head of Engineering", "purpose": "..." }
    ],
    "accountabilities": [ ... ],
    "version": "1717312345678"
  }
}
```

### Field reference

- `protocolVersion` — always `"1.0"` for now.
- `org_id` / `unit_id` / `agent_id` — top-level per the EMQX A2A spec. EMQX A2A Registry indexes these.
- `name` — human-readable agent name.
- `description` — agent title concatenated with the most descriptive role purpose.
- `version` — monotonic string (millisecond timestamp from `agents.updated_at`). Bumps on each re-projection.
- `url` — A2A endpoint URL. Currently the internal placeholder `mqtt://internal/<agentId>` until external HTTP exposure ships.
- `skills[]` — derived from the agent's accountabilities. Each has A2A v1.0's required `id`, `name`, `description`.
- `capabilities.streaming` — `true` for adapters that natively stream tokens (bedrock_gateway, claude_local). `false` for subprocess-CLI adapters (hermes_local).
- `capabilities.pushNotifications` — always `false` today.
- `paperclip.*` — Paperclip-specific deep metadata. Namespaced to avoid colliding with future A2A fields. External A2A clients SHOULD ignore unknown fields rather than reject the Card.

The Paperclip host singleton publishes Agent Cards on behalf of every managed agent. Plugin workers and external A2A agents publish their own Cards from their own MQTT client (so the `clientId` of the publisher matches the triple). Both paths land at the same topic with the same shape.

## 7. Authentication

### Current state — per-agent HMAC password

EMQX validates every MQTT CONNECT against the Paperclip host via an HTTP-ACL hook (`POST /api/internal/mqtt-auth`). The host validates two distinct identities:

**Host singleton.** Connects with username `paperclip-host` and password `PAPERCLIP_MQTT_HOST_PASSWORD`. Granted `is_superuser`.

**Per-agent.** Username is the three-part triple `{companyId}/{circleId}/{agentId}` (all UUIDs). Password is:

```
HMAC-SHA256( keyHash + ":" + companyId + ":" + agentId , MQTT_AUTH_SECRET )
```

Encoded as base64url. The `keyHash` is the agent's most recent non-revoked `agent_api_keys` row. `MQTT_AUTH_SECRET` resolves from (in order) `PAPERCLIP_MQTT_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`, or `BETTER_AUTH_SECRET`.

External integrators who want to operate **as a managed Paperclip agent** must obtain an `agent_api_keys` row from the host (today: by being provisioned via the admin API) and derive the password the same way. The Paperclip host exposes `computeAgentMqttPassword` from `server/src/mqtt/auth-backend.ts` and re-exports the same derivation in the `a2a_mqtt` adapter so test harnesses can compute it identically.

### Service-account path

For integrators who are not themselves an agent (n8n nodes, ops CLIs, second Paperclip instances publishing directives), provision a separate broker-level account with topic-scoped publish + subscribe permissions. The username does not look like an agent triple, so the host's per-agent path is skipped; the broker handles authentication against its own credentials store. Treat the service account as superuser-equivalent within its scope and rotate the credential out-of-band.

### Coming — OAuth2 bearer (E10)

The EMQX A2A spec defines an `a2a-authorization` MQTT user property whose value is `Bearer <token>`. The intent: external integrators present a JWT issued by an OAuth2 provider on every request, and the broker / host validates it without needing per-agent password derivation. Paperclip has this tracked as **E10**. Not yet shipped. When it lands:

- External clients will be able to connect with a single OAuth2 bearer scoped to one or more orgs.
- The `a2a-authorization` user property will appear on requests originated by those clients.
- The HMAC path described above will remain for in-house managed agents.

Until then, the only supported external-auth surfaces are the per-agent HMAC password or a service-account broker credential.

## 8. Example clients

These snippets show a request/reply round-trip against Paperclip from three integration surfaces. All three connect to the same broker, use the same topic shape, and stamp the same user properties.

### 8.1 Python (`python-a2a` library)

```python
# pip install python-a2a paho-mqtt
import json, uuid
from a2a.client import A2AMQTTClient  # python-a2a's MQTT binding

ORG  = "11111111-1111-1111-1111-111111111111"
UNIT = "22222222-2222-2222-2222-222222222222"
AGENT_TO = "33333333-3333-3333-3333-333333333333"   # target Paperclip agent
AGENT_ME = "44444444-4444-4444-4444-444444444444"   # your registered agent id

client = A2AMQTTClient(
    broker_url="mqtt://broker.paperclip.example:1883",
    client_id=f"{ORG}/{UNIT}/{AGENT_ME}",
    username=f"{ORG}/{UNIT}/{AGENT_ME}",
    password="<HMAC-SHA256 over keyHash:org:agent, base64url>",
)
client.connect()

# Discover the target's Agent Card (retained).
card = client.read_retained(f"$a2a/v1/discovery/{ORG}/{UNIT}/{AGENT_TO}")
print(card["name"], card["skills"])

# Send a Task.
task_id = str(uuid.uuid4())
client.publish(
    topic=f"$a2a/v1/request/{ORG}/{UNIT}/{AGENT_TO}",
    payload=json.dumps({
        "id": task_id,
        "message": {"role": "user", "parts": [{"kind": "text", "text": "Summarise the Q2 launch plan."}]},
    }),
    user_properties={
        "a2a-task-id": task_id,
        "a2a-content": "task",
    },
    qos=1,
)

# Subscribe to the reply BEFORE publishing in real code; shown inline for brevity.
reply = client.await_reply(
    topic=f"$a2a/v1/reply/{ORG}/{UNIT}/{AGENT_TO}/{task_id}",
    timeout_s=120,
)
print(reply["summary"])
```

If `python-a2a`'s MQTT binding isn't a drop-in for your environment, fall back to raw `paho-mqtt` and assemble the topics + user properties yourself — the wire format is what matters.

### 8.2 Node (`@a2aproject/a2a` SDK or raw `mqtt`)

```ts
// pnpm add @a2aproject/a2a mqtt
import mqtt from "mqtt";
import { randomUUID } from "crypto";

const ORG  = "11111111-1111-1111-1111-111111111111";
const UNIT = "22222222-2222-2222-2222-222222222222";
const AGENT_TO = "33333333-3333-3333-3333-333333333333";
const AGENT_ME = "44444444-4444-4444-4444-444444444444";

const triple = `${ORG}/${UNIT}/${AGENT_ME}`;
const client = mqtt.connect("mqtt://broker.paperclip.example:1883", {
  protocolVersion: 5,
  clientId: triple,
  username: triple,
  password: "<HMAC-SHA256 over keyHash:org:agent, base64url>",
  clean: true,
});

await new Promise((r) => client.once("connect", r));

const taskId = randomUUID();
const replyTopic = `$a2a/v1/reply/${ORG}/${UNIT}/${AGENT_TO}/${taskId}`;
await new Promise<void>((resolve, reject) =>
  client.subscribe(replyTopic, { qos: 1 }, (err) => (err ? reject(err) : resolve()))
);

const replyP = new Promise<any>((resolve) => {
  client.on("message", (topic, payload) => {
    if (topic === replyTopic) resolve(JSON.parse(payload.toString()));
  });
});

client.publish(
  `$a2a/v1/request/${ORG}/${UNIT}/${AGENT_TO}`,
  JSON.stringify({
    id: taskId,
    message: { role: "user", parts: [{ kind: "text", text: "Summarise the Q2 launch plan." }] },
  }),
  {
    qos: 1,
    properties: {
      contentType: "application/json",
      userProperties: {
        "a2a-task-id": taskId,
        "a2a-content": "task",
      },
    },
  }
);

const reply = await replyP;
console.log(reply.summary);
```

When `@a2aproject/a2a`'s MQTT transport ships as a stable artifact, this collapses to a single `client.sendTask(...)` call. Until then, the raw `mqtt` v5 client above is the most portable approach and exactly mirrors what Paperclip's adapter does internally (`packages/adapters/adapter-a2a-mqtt/src/server/execute.ts`).

### 8.3 n8n

n8n ships an **MQTT Trigger** node and an **MQTT** action node (both backed by `mqtt` v5). To subscribe to a circle's event stream:

- **Broker URL:** `mqtt://broker.paperclip.example:1883` (or `mqtts://` if your deployment terminates TLS).
- **Credential type:** "MQTT" credential. Username + password.
  - For a per-agent integration: use the agent triple as both `clientId` and username; derive the HMAC password as in Section 7.
  - For an integration node (typical n8n use case): use a service-account credential provisioned out-of-band. The clientId can be any unique string.
- **Topic to subscribe (event feed):** `$a2a/v1/event/{org}/{unit}/+`.
- **QoS:** 1 for reliable delivery; 0 if you can tolerate drops.
- **JSON parse:** enable — payloads are `application/json`.

To publish a directive (fan-out to every lead link in an org), use the **MQTT** action node with topic `$a2a/v1/directive/{org}`, QoS 1, retain false, and payload as the JSON from Section 3.5.

## 9. Federation

EMQX brokers support cluster-to-cluster bridging out of the box. Two Paperclip instances on separate brokers can in principle bridge their `$a2a/v1/...` namespaces such that an agent on instance A can read Agent Cards from and send Tasks to an agent on instance B.

What's true today:

- The topic taxonomy is org-scoped (`$a2a/v1/.../{org}/...`), so a bridge can be scoped to specific orgs without leaking traffic.
- The Agent Card includes `org_id` at the top level — federated consumers can deduplicate and route on it.
- The auth model is per-instance. Each side enforces its own credential check; bridged traffic appears as the bridge's service account on the receiving side.

What's deferred:

- A concrete bridge config example (EMQX `connector` + `bridge` declarations, ACL grants on both sides) is not yet documented here. When Paperclip ships its first federation deployment we will publish the config alongside.
- Cross-instance task tracing (run-id correlation across two run logs) is not yet implemented.

If you're planning a federation deployment in advance of that, open an issue — the protocol surface is stable enough that the broker-side config is the only missing piece.

---

### Appendix A — Canonical sources

These files in the Paperclip repo are authoritative; this document is a public projection of them and will lag by at most one minor release:

- Topic names and builders: `packages/adapters/adapter-a2a-mqtt/src/server/topics.ts`
- Agent Card shape and projector: `server/src/mqtt/agent-card-projector.ts`
- MQTT auth path: `server/src/mqtt/auth-backend.ts`
- Per-agent client + LWT registration: `server/src/mqtt/per-agent-client-manager.ts`
- Task publish + user-property stamping: `packages/adapters/adapter-a2a-mqtt/src/server/execute.ts`

### Appendix B — Glossary

- **A2A** — Agent-to-Agent. Google / a2aproject's open protocol for one agent to send a Task to another and receive a structured reply.
- **A2A Registry** — EMQX's broker-side index of live agents, populated by retained Agent Cards on `$a2a/v1/discovery/+/+/+`.
- **Agent Card** — A JSON document describing one agent (identity, skills, capabilities). Retained on the discovery topic so late subscribers see it immediately.
- **Circle** — A Holacracy team. Paperclip's `unit_id` in the A2A triple.
- **Directive** — A Paperclip-specific extension topic that fans an inbound command out into per-recipient issues.
- **LWT** — Last Will and Testament. The MQTT v5 message a broker publishes on a client's behalf when its connection drops.
- **Pool topic** — A `request` topic addressed to a role rather than a specific agent, dispatched by the broker via shared subscription to exactly one role-holder.
- **Shared subscription** — MQTT v5 feature (`$share/<group>/<topic>`) that distributes one copy of each message to one subscriber in a named group. Paperclip uses it for role and skill pools.
