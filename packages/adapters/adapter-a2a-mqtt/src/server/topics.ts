/**
 * A2A-over-MQTT topic format constants and builders.
 *
 * The canonical Paperclip A2A topic namespace. All topics live under
 * `paperclip/v1/...`. The companyId/circleId/agentId components are UUIDs
 * (validated broker-side in production via an EMQX topic-validator hook).
 *
 * Topic shape:
 *   paperclip/v1/discovery/{companyId}/{circleId}/{agentId}   (retained Agent Card)
 *   paperclip/v1/request/{companyId}/{circleId}/{agentId}     (Task request inbox)
 *   paperclip/v1/request/{companyId}/{circleId}/pool/{roleId} (pool inbox; shared subs)
 *   paperclip/v1/reply/{companyId}/{circleId}/{agentId}/{taskId} (Task reply, ephemeral)
 *   paperclip/v1/event/{companyId}/{circleId}/{agentId}       (agent events)
 *   paperclip/v1/idm/{companyId}/{circleId}/{idmId}/phase     (IDM phase transitions)
 *   paperclip/v1/idm/{companyId}/{circleId}/{idmId}/input     (IDM participant inputs)
 *   paperclip/v1/crosslink/{companyId}/{crossLinkId}          (cross-link channel)
 */

export const TOPIC_PREFIX = "paperclip/v1";

export function discoveryTopic(
  companyId: string,
  circleId: string,
  agentId: string,
): string {
  return `${TOPIC_PREFIX}/discovery/${companyId}/${circleId}/${agentId}`;
}

export function requestTopic(
  companyId: string,
  circleId: string,
  agentId: string,
): string {
  return `${TOPIC_PREFIX}/request/${companyId}/${circleId}/${agentId}`;
}

export function poolRequestTopic(
  companyId: string,
  circleId: string,
  roleId: string,
): string {
  return `${TOPIC_PREFIX}/request/${companyId}/${circleId}/pool/${roleId}`;
}

export function replyTopic(
  companyId: string,
  circleId: string,
  agentId: string,
  taskId: string,
): string {
  return `${TOPIC_PREFIX}/reply/${companyId}/${circleId}/${agentId}/${taskId}`;
}

export function eventTopic(
  companyId: string,
  circleId: string,
  agentId: string,
): string {
  return `${TOPIC_PREFIX}/event/${companyId}/${circleId}/${agentId}`;
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
 */
export function hostEventTopic(
  companyId: string,
  circleId: string,
  channel: string,
): string {
  return `${TOPIC_PREFIX}/event/${companyId}/${circleId}/${channel}`;
}

export function discoveryWildcard(companyId: string): string {
  return `${TOPIC_PREFIX}/discovery/${companyId}/+/+`;
}

export function requestWildcardForCircle(
  companyId: string,
  circleId: string,
): string {
  return `${TOPIC_PREFIX}/request/${companyId}/${circleId}/+`;
}

export function eventWildcardForCircle(
  companyId: string,
  circleId: string,
): string {
  return `${TOPIC_PREFIX}/event/${companyId}/${circleId}/+`;
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
  return `${TOPIC_PREFIX}/event/${companyId}/${circleId}/+`;
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
