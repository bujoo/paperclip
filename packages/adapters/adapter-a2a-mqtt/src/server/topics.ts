/**
 * A2A-over-MQTT topic format constants and builders.
 *
 * Two prefixes (Phase 1.16-EMQX E1):
 *
 * 1. **`$a2a/v1/...`** — the 5 dimensions defined by the EMQX A2A spec +
 *    Google's open A2A protocol (discovery, request, reply, event, pool).
 *    EMQX's A2A Registry auto-indexes Agent Cards published to
 *    `$a2a/v1/discovery/+/+/+`, tracks per-agent liveness via LWT, and
 *    routes interop with any A2A-compliant client (python-a2a,
 *    @a2aproject/a2a, etc.). `{org_id}/{unit_id}/{agent_id}` from the
 *    spec maps directly to our `{companyId}/{circleId}/{agentId}`.
 *
 * 2. **`paperclip/v1/...`** — Paperclip-specific transport that doesn't
 *    fit the A2A spec (heartbeat polyrhythm, retained Company DNA, IDM
 *    phase channels, circle discussions, role + skill pools, crosslinks).
 *    These ride normal MQTT routing — no A2A Registry involvement.
 *
 * Topic shape:
 *   $a2a/v1/discovery/{companyId}/{circleId}/{agentId}    (retained Agent Card, A2A-spec)
 *   $a2a/v1/request/{companyId}/{circleId}/{agentId}      (Task request inbox, A2A-spec)
 *   $a2a/v1/request/{companyId}/{circleId}/pool/{roleId}  (pool inbox; shared subs, A2A-spec)
 *   $a2a/v1/reply/{companyId}/{circleId}/{agentId}/{taskId} (Task reply, A2A-spec)
 *   $a2a/v1/event/{companyId}/{circleId}/{agentId}        (agent events, A2A-spec)
 *   paperclip/v1/heartbeat/{companyId}                    (host polyrhythm)
 *   paperclip/v1/heartbeat-ack/{companyId}/{agentId}      (per-agent ACK)
 *   paperclip/v1/dna/{companyId}                          (retained Company DNA)
 *   paperclip/v1/idm/{companyId}/{circleId}/{idmId}/phase (IDM phase transitions)
 *   paperclip/v1/idm/{companyId}/{circleId}/{idmId}/input (IDM participant inputs)
 *   paperclip/v1/crosslink/{companyId}/{crossLinkId}      (cross-link channel)
 *   paperclip/v1/role/...                                 (role pool + broadcast)
 *   paperclip/v1/skill/...                                (skill pool + broadcast)
 *   paperclip/v1/discussion/{companyId}/{contextId}       (circle discussion feed)
 *
 * The `$` prefix is an EMQX-reserved namespace; the ACL backend
 * (server/src/mqtt/acl-backend.ts) must explicitly allow `$a2a/...`
 * subscribes per agent.
 */

/** A2A-spec compliant prefix. Indexed by EMQX A2A Registry. */
export const A2A_PREFIX = "$a2a/v1";

/** Paperclip-specific transport prefix. Normal MQTT routing. */
export const TOPIC_PREFIX = "paperclip/v1";

export function discoveryTopic(
  companyId: string,
  circleId: string,
  agentId: string,
): string {
  return `${A2A_PREFIX}/discovery/${companyId}/${circleId}/${agentId}`;
}

export function requestTopic(
  companyId: string,
  circleId: string,
  agentId: string,
): string {
  return `${A2A_PREFIX}/request/${companyId}/${circleId}/${agentId}`;
}

export function poolRequestTopic(
  companyId: string,
  circleId: string,
  roleId: string,
): string {
  return `${A2A_PREFIX}/request/${companyId}/${circleId}/pool/${roleId}`;
}

export function replyTopic(
  companyId: string,
  circleId: string,
  agentId: string,
  taskId: string,
): string {
  return `${A2A_PREFIX}/reply/${companyId}/${circleId}/${agentId}/${taskId}`;
}

export function eventTopic(
  companyId: string,
  circleId: string,
  agentId: string,
): string {
  return `${A2A_PREFIX}/event/${companyId}/${circleId}/${agentId}`;
}

export function idmPhaseTopic(
  companyId: string,
  circleId: string,
  idmId: string,
): string {
  return `${TOPIC_PREFIX}/idm/${companyId}/${circleId}/${idmId}/phase`;
}

export function idmInputTopic(
  companyId: string,
  circleId: string,
  idmId: string,
): string {
  return `${TOPIC_PREFIX}/idm/${companyId}/${circleId}/${idmId}/input`;
}

export function crossLinkTopic(companyId: string, crossLinkId: string): string {
  return `${TOPIC_PREFIX}/crosslink/${companyId}/${crossLinkId}`;
}

/**
 * Phase 1.17 — Company-wide directive topic. ONE inbound publish from
 * an external client (CLI, n8n, service account, another Paperclip
 * instance) triggers the server to materialise N issues for the targeted
 * recipients (typically each circle's Lead Link). Each recipient agent
 * wakes via the normal `issue.assigned` path and acts on the directive
 * using their bundled skills.
 *
 * Payload shape:
 *   {
 *     "kind": "plan-routines" | "plan-goals" | "weekly-review" | ...,
 *     "body": "free-text instruction included in each materialised issue",
 *     "scope": "lead_links" | "all_agents" | { "circleIds": ["..."] }
 *   }
 *
 * ACL: service-account publish allowed; host subscribe to materialise.
 */
export function directiveTopic(companyId: string): string {
  return `${A2A_PREFIX}/directive/${companyId}`;
}

/**
 * Phase 1.8 — Host heartbeat broadcast per company. Carries the polyrhythm
 * snapshot and degraded-mode state. Published QoS 0, retain false (every
 * subscriber sees the live tick; late joiners wait < 30s for the next one).
 */
export function heartbeatTopic(companyId: string): string {
  return `${TOPIC_PREFIX}/heartbeat/${companyId}`;
}

/**
 * Phase 1.8 — Per-agent heartbeat ACK. The agent publishes here in response
 * to a heartbeat tick on `heartbeatTopic(companyId)`. Payload carries
 * `{tickId, queueDepth, focusedOnIssueId?}`.
 */
export function heartbeatAckTopic(companyId: string, agentId: string): string {
  return `${TOPIC_PREFIX}/heartbeat-ack/${companyId}/${agentId}`;
}

export function heartbeatAckWildcard(): string {
  return `${TOPIC_PREFIX}/heartbeat-ack/+/+`;
}

/**
 * Phase 1.9 — Retained Company DNA envelope. One retained message per
 * company; every agent in the company subscribes. QoS 1, retain true.
 */
export function dnaTopic(companyId: string): string {
  return `${TOPIC_PREFIX}/dna/${companyId}`;
}

/**
 * Generic event topic that does not require an agentId scope. Used by the
 * heartbeat bridge for the host-level escalation + watchdog-decision events
 * (`{circleId}=_` and `{agentId}` slot used to carry the event sub-channel).
 * Uses A2A prefix because EMQX A2A Registry may want to surface these as
 * agent events under the spec.
 */
export function hostEventTopic(
  companyId: string,
  circleId: string,
  channel: string,
): string {
  return `${A2A_PREFIX}/event/${companyId}/${circleId}/${channel}`;
}

export function discoveryWildcard(companyId: string): string {
  return `${A2A_PREFIX}/discovery/${companyId}/+/+`;
}

export function requestWildcardForCircle(
  companyId: string,
  circleId: string,
): string {
  return `${A2A_PREFIX}/request/${companyId}/${circleId}/+`;
}

export function eventWildcardForCircle(
  companyId: string,
  circleId: string,
): string {
  return `${A2A_PREFIX}/event/${companyId}/${circleId}/+`;
}

// ---------------------------------------------------------------------------
// Phase 1.10 — Multi-dimensional addressing (role pool + skill pool + broadcasts)
// ---------------------------------------------------------------------------

/**
 * Normalise an arbitrary human label (accountability name, role name) into a
 * slug suitable for use inside an MQTT topic segment. Lowercases, replaces
 * runs of non-alphanumerics with `-`, and trims surrounding `-`. The same
 * algorithm is used at publish time (host computes the slug from the
 * requested skill name) and subscribe time (each agent computes it from its
 * accountability names) so both sides agree on routing.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Subscribe-side wildcard for a circle's event feed: every agent in the circle gets it. */
export function eventCircleWildcard(
  companyId: string,
  circleId: string,
): string {
  return `${A2A_PREFIX}/event/${companyId}/${circleId}/+`;
}

/**
 * Role pool dispatch topic. Publishers send work to a role; the broker uses
 * a shared subscription group to round-robin to exactly one holder of the
 * role. See `sharedSubGroup` for the consumer-side wrapper.
 */
export function rolePoolTopic(
  companyId: string,
  circleId: string,
  roleId: string,
): string {
  return `${TOPIC_PREFIX}/role/${companyId}/${circleId}/${roleId}`;
}

/** Role broadcast topic — every agent holding the role receives a copy. */
export function roleBroadcastTopic(
  companyId: string,
  circleId: string,
  roleId: string,
): string {
  return `${TOPIC_PREFIX}/role/${companyId}/${circleId}/${roleId}/broadcast`;
}

/**
 * Skill pool dispatch topic. Cross-circle by design — the skill bus is
 * org-scoped, so any agent in the company whose accountability slugifies to
 * the given slug is eligible for shared-sub round-robin.
 */
export function skillPoolTopic(
  companyId: string,
  skillSlug: string,
): string {
  return `${TOPIC_PREFIX}/skill/${companyId}/${skillSlug}`;
}

/** Skill broadcast topic — every agent with the skill receives a copy. */
export function skillBroadcastTopic(
  companyId: string,
  skillSlug: string,
): string {
  return `${TOPIC_PREFIX}/skill/${companyId}/${skillSlug}/broadcast`;
}

/**
 * Wrap a topic filter in an MQTT 5 shared-subscription envelope. The broker
 * delivers each message to exactly one subscriber in the named group, which
 * gives us load-balanced delivery semantics for role and skill pools without
 * any application-side leader election.
 */
export function sharedSubGroup(group: string, topic: string): string {
  return `$share/${group}/${topic}`;
}
