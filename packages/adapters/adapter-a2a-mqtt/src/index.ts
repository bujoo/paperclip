export const type = "a2a_mqtt";
export const label = "A2A over MQTT";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# a2a_mqtt agent configuration

Adapter: a2a_mqtt

Speaks the **A2A (Agent2Agent) v1.0 protocol over MQTT v5** to invoke a remote
agent. The remote agent can be another Paperclip-managed agent (the default
case) or any external A2A-conformant agent (Claude, LangChain, AutoGen,
custom enterprise agents) that publishes its Agent Card on the Paperclip
discovery topic.

Each \`execute()\` call:
1. Opens a short-lived MQTT v5 session to the configured broker.
2. Publishes an A2A Task to the target agent's request topic
   (\`paperclip/v1/request/{companyId}/{circleId}/{agentId}\`).
3. Awaits the reply on a per-task ephemeral topic
   (\`paperclip/v1/reply/{companyId}/{circleId}/{agentId}/{taskId}\`),
   correlated via MQTT v5 \`responseTopic\` + \`correlationData\`.
4. Returns the Task result as an AdapterExecutionResult.

Use when:
- You want Paperclip to dispatch work to an external A2A agent without bundling
  that agent's runtime in-process.
- You're integrating a third-party A2A-compliant agent (the A2A spec is the
  interop contract).
- You want shared-subscription pool dispatch — multiple agents holding the same
  role consume from \`paperclip/v1/request/{companyId}/{circleId}/pool/{roleId}\`.

Don't use when:
- The agent runs in the same process (use \`claude_local\` / \`codex_local\` /
  \`opencode_local\` / \`gemini_local\` etc).
- You only need a single-hop function call to a hosted LLM (use
  \`bedrock_gateway\` or a direct provider adapter).

Authentication:
The adapter authenticates **to the MQTT broker** (EMQX). The broker's authz
backend (ACL HTTP callback) computes per-connect topic permissions from
\`role_assignments × roles × circles × circle_cross_links\`. The adapter
itself does not enforce policy — the broker does. Pass MQTT credentials via:

- \`username\` (string, required for production): MQTT username. By convention
  Paperclip uses the agent's UUID for per-agent identity, but the broker
  accepts any string the ACL backend recognises.
- \`password\` (string, secret): MQTT password or token. For dev with no auth
  (the EMQX default), leave both fields blank.

Core fields:
- brokerUrl (string, required): broker endpoint. e.g. \`mqtt://localhost:1883\`
  (TCP), \`mqtts://emqx.example.com:8883\` (TLS), \`ws://...:8083/mqtt\`
  (WebSocket), \`wss://...:8084/mqtt\` (WebSocket TLS).
- companyId (string, optional): UUID of the Paperclip company that owns the
  target agent. Defaults to the agent's home company resolved from the agent
  row.
- circleId (string, required): UUID of the circle the target agent is acting
  inside. This is part of the topic path and is therefore not optional.
- agentId (string, optional): UUID of the target agent. Defaults to the agent
  record's id when the adapter is bound to a single agent.
- poolRoleId (string, optional): when set, requests are dispatched to the
  shared-subscription pool topic for this role
  (\`paperclip/v1/request/{companyId}/{circleId}/pool/{roleId}\`) instead of
  the per-agent topic. Any agent holding the role will pick up the next request.
- username (string, optional): MQTT broker username.
- password (string, secret, optional): MQTT broker password.
- timeoutSec (number, optional, default 60): reply wait timeout in seconds.
  Exceeding this returns \`timedOut: true\` with errorFamily =
  \`transient_upstream\` so the host's retry policy can kick in.
- cardWaitMs (number, optional, default 2000): how long \`testEnvironment\` and
  \`listSkills\` wait for the broker to flush retained Agent Cards before
  giving up.

Topic conventions (read-only, owned by this package):
- \`paperclip/v1/discovery/{companyId}/{circleId}/{agentId}\` — retained Agent Card.
- \`paperclip/v1/request/{companyId}/{circleId}/{agentId}\` — Task inbox.
- \`paperclip/v1/reply/{companyId}/{circleId}/{agentId}/{taskId}\` — Task reply.
- \`paperclip/v1/event/{companyId}/{circleId}/{agentId}\` — agent events.

Notes:
- Set \`PAPERCLIP_MQTT_BROKER_URL\` in the host environment so the host
  singleton + Agent Card projector pick up the same broker; the adapter's
  \`brokerUrl\` field overrides per-agent.
- For local dev, EMQX is provisioned in \`docker/docker-compose.yml\` and runs
  with no auth on \`mqtt://localhost:1883\` (and the dashboard on
  http://localhost:18083 with user \`admin\` / password \`public\`).
- Agent Cards are projected by the host (see
  \`server/src/mqtt/agent-card-projector.ts\`); this adapter never writes its
  own discovery topic.
`;
