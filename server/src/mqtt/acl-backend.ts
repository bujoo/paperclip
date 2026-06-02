/**
 * EMQX HTTP ACL backend for the A2A-over-MQTT transport.
 *
 * EMQX calls `POST /api/internal/mqtt-acl` on every MQTT CONNECT (configured
 * as connect-time ACL fetch rather than per-publish — see EMQX docs at
 * https://docs.emqx.com/en/enterprise/v5.10/access-control/authz/http.html).
 *
 * Request shape per EMQX HTTP authorizer:
 *
 *   {
 *     "username": "{companyId}/{circleId}/{agentId}" | "host:paperclip-server",
 *     "clientid": "...",
 *     "action": "publish" | "subscribe" | "all",
 *     "topic":   "..."   // empty when EMQX is configured for connect-time bulk fetch
 *   }
 *
 * We return the EMQX-shaped response:
 *
 *   { result: "allow" } | { result: "deny" } | { result: "ignore" }
 *
 * Optionally with a `permissions` array on the connect-time variant. Because
 * EMQX supports both single-action and bulk modes and the exact shape varies
 * between Community and Enterprise editions, this implementation answers
 * **per-topic per-action** (the safer common subset). EMQX caches the
 * positive answers per-client; topic patterns matter, not the number of
 * round-trips.
 *
 * Topic allowlist policy (per agent identity):
 *
 *   PUBLISH allowed when topic matches any of:
 *     paperclip/v1/discovery/{companyId}/{circleId}/{agentId}      (own card)
 *     paperclip/v1/event/{companyId}/{circleId}/{agentId}          (own events)
 *     paperclip/v1/reply/{companyId}/{circleId}/{agentId}/+        (own replies)
 *     paperclip/v1/request/{companyId}/{otherCircleId}/+           (request to circle-mate)
 *     paperclip/v1/request/{companyId}/{otherCircleId}/pool/+      (pool dispatch)
 *     paperclip/v1/crosslink/{companyId}/{crossLinkId}             (cross-link channels)
 *     paperclip/v1/idm/{companyId}/{circleId}/+/input              (IDM participant input)
 *
 *   SUBSCRIBE allowed when topic filter matches any of:
 *     paperclip/v1/request/{companyId}/{ownCircleId}/{agentId}     (own inbox)
 *     paperclip/v1/request/{companyId}/{ownCircleId}/pool/+        (pool inbox the agent can join)
 *     paperclip/v1/reply/{companyId}/{circleId}/{agentId}/+        (own reply channel)
 *     paperclip/v1/event/{companyId}/{ownCircleId}/+               (circle event feed)
 *     paperclip/v1/discovery/{companyId}/+/+                       (company-wide discovery)
 *     paperclip/v1/crosslink/{companyId}/{crossLinkId}             (cross-link channels)
 *     paperclip/v1/idm/{companyId}/{ownCircleId}/+/phase           (IDM phase feed)
 *
 * The host singleton (`username === "host:paperclip-server"`) is allowed on
 * the entire `paperclip/v1/#` namespace and any other broker-internal topic
 * it might use.
 *
 * The result is cached in-process (LRU + TTL) keyed on agentId. The cache
 * MUST be invalidated when role_assignments change — see `invalidateAclCache()`.
 * Redis would be a natural backing store; for now we use a process-local
 * cache so the round-2 implementation doesn't introduce a Redis dependency.
 */

import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { slugify } from "@paperclipai/adapter-a2a-mqtt/server";
import { HOST_MQTT_USERNAME } from "./client.js";
import { logger } from "../middleware/logger.js";
import { coerceRowsList } from "../util/db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACL_CACHE_TTL_MS = 600 * 1000; // 10 minutes

interface AgentAclProfile {
  companyId: string;
  agentId: string;
  /** Circles the agent is assigned to within its home company. */
  ownCircleIds: string[];
  /** Roles the agent holds — used for pool subscription eligibility. */
  ownRoleIds: string[];
  /** Cross-link UUIDs the agent participates in (best-effort; empty when schema is absent). */
  crossLinkIds: string[];
  /**
   * Phase 1.10 — slugified accountability names. Each slug grants
   * subscribe access to the matching skill bus + skill broadcast topics.
   */
  ownSkillSlugs: string[];
  /**
   * Phase 1.15a — a2a_context_ids for open circle_discussions this agent
   * participates in. Each grants subscribe access to
   * `paperclip/v1/discussion/{companyId}/{contextId}`.
   */
  ownDiscussionContextIds: string[];
}

interface CachedAcl {
  profile: AgentAclProfile;
  expiresAt: number;
}

const _aclCache: Map<string, CachedAcl> = new Map();

/**
 * Concurrent ACL-load de-duplication.
 *
 * When EMQX asks our backend about an agent whose cache entry is empty, we
 * spawn a DB load. If several ACL requests for the same agent arrive in
 * quick succession (e.g. one publish + one subscribe within ms of each
 * other) we want all of them to await the SAME in-flight load — otherwise
 * they each issue a SELECT that may read a slightly different snapshot,
 * and whichever finishes LAST wins the cache write.
 */
const _aclInFlight: Map<string, Promise<AgentAclProfile>> = new Map();

/**
 * Per-agent invalidation epoch. Bumped by `invalidateAclCache(agentId)` so
 * a load started BEFORE invalidate can detect that its snapshot is now
 * stale and skip writing to cache (the next request triggers a fresh load
 * that runs AFTER any pending DB commits — e.g. the freshly-inserted
 * `circle_discussions` row).
 */
const _aclEpoch: Map<string, number> = new Map();

/**
 * Public hook called by `role_assignment.created` / `role_assignment.deleted`
 * / `discussion.create` (or any other event that changes an agent's
 * circle/role/discussion membership) so the next ACL fetch goes back to the DB.
 */
export function invalidateAclCache(agentId: string | null = null): void {
  if (agentId === null) {
    _aclCache.clear();
    _aclInFlight.clear();
    for (const id of [..._aclEpoch.keys()]) {
      _aclEpoch.set(id, (_aclEpoch.get(id) ?? 0) + 1);
    }
    logger.debug({ scope: "all" }, "mqtt-acl: cache invalidated");
    return;
  }
  const hadEntry = _aclCache.has(agentId);
  _aclCache.delete(agentId);
  _aclInFlight.delete(agentId);
  _aclEpoch.set(agentId, (_aclEpoch.get(agentId) ?? 0) + 1);
  logger.debug({ agentId, hadEntry }, "mqtt-acl: cache invalidated");
}

/** Best-effort DB load. Returns an empty profile if the holacracy schema is absent. */
async function loadAclProfile(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<AgentAclProfile> {
  let ownCircleIds: string[] = [];
  let ownRoleIds: string[] = [];
  let crossLinkIds: string[] = [];
  let ownSkillSlugs: string[] = [];
  let ownDiscussionContextIds: string[] = [];

  // role_assignments live in plugin-holacracy's namespace.
  try {
    const rows = await db.execute<{ circleId: string; roleId: string } & Record<string, unknown>>(sql`
      SELECT
        c.id::text AS "circleId",
        r.id::text AS "roleId"
      FROM plugin_holacracy_c5049b5dfe.role_assignments ra
      JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
      JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
      WHERE ra.agent_id = ${agentId}::uuid
        AND c.company_id = ${companyId}::uuid
    `);
    const list = coerceRowsList<{ circleId: string; roleId: string }>(rows);
    const circleSet = new Set<string>();
    const roleSet = new Set<string>();
    for (const row of list) {
      circleSet.add(row.circleId);
      roleSet.add(row.roleId);
    }
    ownCircleIds = [...circleSet];
    ownRoleIds = [...roleSet];
  } catch (err) {
    logger.debug({ err, agentId }, "mqtt-acl: holacracy role_assignments unavailable");
  }

  // Cross-links (best-effort). The table may not exist in every install.
  try {
    const rows = await db.execute<{ crossLinkId: string } & Record<string, unknown>>(sql`
      SELECT cl.id::text AS "crossLinkId"
      FROM plugin_holacracy_c5049b5dfe.cross_links cl
      WHERE cl.company_id = ${companyId}::uuid
        AND (
          cl.source_circle_id = ANY(${ownCircleIds}::uuid[])
          OR cl.target_circle_id = ANY(${ownCircleIds}::uuid[])
        )
    `);
    const list = coerceRowsList<{ crossLinkId: string }>(rows);
    crossLinkIds = list.map((row) => row.crossLinkId);
  } catch {
    // cross_links table not in schema — that's fine, leave empty.
  }

  // Phase 1.10 — skill slugs derived from agents.accountabilities. Lives in
  // public.agents so this query is always available regardless of plugin
  // schema state.
  try {
    const rows = await db.execute<{ accountabilities: Array<Record<string, unknown>> | null }>(sql`
      SELECT COALESCE(accountabilities, '[]'::jsonb) AS "accountabilities"
      FROM public.agents
      WHERE id = ${agentId}::uuid
        AND company_id = ${companyId}::uuid
      LIMIT 1
    `);
    const list = coerceRowsList<{ accountabilities: Array<Record<string, unknown>> | null }>(rows);
    const accountabilities = list[0]?.accountabilities ?? [];
    const slugs = new Set<string>();
    if (Array.isArray(accountabilities)) {
      for (const acc of accountabilities) {
        const name =
          acc && typeof acc.name === "string" && acc.name.trim().length > 0
            ? acc.name.trim()
            : null;
        if (!name) continue;
        const slug = slugify(name);
        if (slug.length > 0) slugs.add(slug);
      }
    }
    ownSkillSlugs = [...slugs];
  } catch (err) {
    logger.debug({ err, agentId }, "mqtt-acl: accountabilities load failed");
  }

  // Phase 1.15a — discussion topics. Each open discussion this agent
  // participates in grants subscribe access to its discussion event topic.
  try {
    const rows = await db.execute<{ contextId: string } & Record<string, unknown>>(sql`
      SELECT a2a_context_id AS "contextId"
      FROM public.circle_discussions
      WHERE status = 'open'
        AND ${agentId}::uuid = ANY(participant_agent_ids)
    `);
    const list = coerceRowsList<{ contextId: string }>(rows);
    ownDiscussionContextIds = list.map((row) => row.contextId);
  } catch (err) {
    logger.debug({ err, agentId }, "mqtt-acl: discussion context load failed");
  }

  return { companyId, agentId, ownCircleIds, ownRoleIds, crossLinkIds, ownSkillSlugs, ownDiscussionContextIds };
}

async function getAclProfile(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<AgentAclProfile> {
  const cached = _aclCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.profile;
  }
  // De-dupe concurrent loads for the same agent. Without this, two ACL
  // requests racing past an `invalidateAclCache` call each fire a SELECT;
  // whichever finishes LAST wins the cache write, and if either captured a
  // pre-INSERT snapshot, the stale answer is what's served until TTL.
  const inFlight = _aclInFlight.get(agentId);
  if (inFlight) return inFlight;
  const epochAtStart = _aclEpoch.get(agentId) ?? 0;
  const promise = (async () => {
    try {
      const profile = await loadAclProfile(db, companyId, agentId);
      // Only write the cache if no invalidation happened during the load.
      // If the epoch was bumped, our snapshot may pre-date a relevant
      // commit (e.g. fresh `circle_discussions` row) and a subsequent
      // request will trigger a fresh, post-invalidate load.
      const epochNow = _aclEpoch.get(agentId) ?? 0;
      if (epochNow === epochAtStart) {
        _aclCache.set(agentId, {
          profile,
          expiresAt: Date.now() + ACL_CACHE_TTL_MS,
        });
      } else {
        logger.debug(
          { agentId, epochAtStart, epochNow },
          "mqtt-acl: discarding stale profile load (cache invalidated during load)",
        );
      }
      return profile;
    } finally {
      _aclInFlight.delete(agentId);
    }
  })();
  _aclInFlight.set(agentId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Topic policy
// ---------------------------------------------------------------------------

interface ParsedTopic {
  segments: string[];
}

function parseTopic(topic: string): ParsedTopic {
  return { segments: topic.split("/") };
}

function segEquals(segments: string[], idx: number, expected: string): boolean {
  return segments[idx] === expected;
}

/** Phase 1.16-EMQX E1 — Accept BOTH topic prefixes: the A2A-spec `$a2a/v1`
 *  (indexed by the EMQX A2A Registry) and Paperclip's `paperclip/v1` (for
 *  transport that doesn't fit the spec — heartbeat, dna, idm, discussion,
 *  role pools, skill pools, crosslinks). The per-channel switch below
 *  doesn't care which prefix routed the topic — segments[2] is always the
 *  channel name. */
function hasKnownPrefix(segments: string[]): boolean {
  if (segments.length < 2) return false;
  const isA2A = segments[0] === "$a2a" && segments[1] === "v1";
  const isPaperclip = segments[0] === "paperclip" && segments[1] === "v1";
  return isA2A || isPaperclip;
}

function isPublishAllowed(profile: AgentAclProfile, topic: string): boolean {
  const { segments } = parseTopic(topic);
  // All A2A/Paperclip topics are at least 4 segments: <prefix>/v1/<channel>/<companyId>/...
  if (segments.length < 4) return false;
  if (!hasKnownPrefix(segments)) return false;
  const channel = segments[2];
  const companyId = segments[3];
  if (companyId !== profile.companyId) return false;

  switch (channel) {
    case "discovery":
      // paperclip/v1/discovery/{companyId}/{circleId}/{agentId}
      if (segments.length !== 6) return false;
      return (
        profile.ownCircleIds.includes(segments[4]!) && segments[5] === profile.agentId
      );

    case "event":
      // paperclip/v1/event/{companyId}/{circleId}/{agentId}            (own events)
      // paperclip/v1/event/{companyId}/{circleId}/tension-raised       (Phase 1.13)
      //
      // Per-agent event topic: publisher must be the named agent and must be
      // a member of the named circle. Phase 1.13 additionally permits the
      // `tension-raised` event sub-channel from any member of the circle —
      // tensions are circle-wide signals, not personal events. Other named
      // sub-channels (`announce`, `tactical-pulse`, etc.) remain host-only
      // so non-personal broadcasts stay host-mediated for spam control.
      if (segments.length !== 6) return false;
      if (!profile.ownCircleIds.includes(segments[4]!)) return false;
      if (segments[5] === profile.agentId) return true;
      if (segments[5] === "tension-raised") return true;
      return false;

    case "reply":
      // paperclip/v1/reply/{companyId}/{circleId}/{agentId}/{taskId}
      if (segments.length !== 7) return false;
      return segments[5] === profile.agentId;

    case "request":
      // paperclip/v1/request/{companyId}/{circleId}/{agentId} OR .../pool/{roleId}
      if (segments.length === 6) {
        // direct request to {agentId}
        return profile.ownCircleIds.length > 0; // any agent in this company may request another (broker-side circle scoping is in subscription policy)
      }
      if (segments.length === 7 && segments[5] === "pool") {
        return true; // any agent in this company may dispatch to a pool
      }
      return false;

    case "crosslink":
      // paperclip/v1/crosslink/{companyId}/{crossLinkId}
      if (segments.length !== 5) return false;
      return profile.crossLinkIds.includes(segments[4]!);

    case "idm":
      // paperclip/v1/idm/{companyId}/{circleId}/{idmId}/input
      if (segments.length !== 7) return false;
      if (segments[6] !== "input") return false;
      return profile.ownCircleIds.includes(segments[4]!);

    // Phase 1.8 — heartbeat ACK from agent → host.
    case "heartbeat-ack":
      // paperclip/v1/heartbeat-ack/{companyId}/{agentId}
      if (segments.length !== 5) return false;
      return segments[4] === profile.agentId;

    // Phase 1.10 — role pool dispatch. Any agent in this company may publish
    // a task into a role pool; the broker round-robins to one holder via
    // shared subscription. Broadcast variants (`.../broadcast`) are NOT
    // allowed for regular agents — only the host singleton may publish
    // broadcasts (handled by the host-bypass branch above).
    case "role":
      // paperclip/v1/role/{companyId}/{circleId}/{roleId}            → pool
      // paperclip/v1/role/{companyId}/{circleId}/{roleId}/broadcast  → denied for agents
      if (segments.length === 6) return true;
      return false;

    // Phase 1.10 — skill pool dispatch. Cross-circle by design — any agent
    // in this company may dispatch into a skill pool. Broadcast denied.
    case "skill":
      // paperclip/v1/skill/{companyId}/{slug}            → pool
      // paperclip/v1/skill/{companyId}/{slug}/broadcast  → denied for agents
      if (segments.length === 5) return true;
      return false;

    default:
      return false;
  }
}

function isSubscribeAllowed(profile: AgentAclProfile, topic: string): boolean {
  // Phase 1.10 — EMQX strips the `$share/<group>/` prefix when checking
  // shared subscriptions against the HTTP ACL backend, so the underlying
  // topic falls through this function unchanged. We accept the shared-sub
  // wrapper here too for defence-in-depth (EMQX builds vary).
  let effectiveTopic = topic;
  if (effectiveTopic.startsWith("$share/")) {
    const afterGroup = effectiveTopic.slice("$share/".length).split("/");
    if (afterGroup.length >= 2) {
      effectiveTopic = afterGroup.slice(1).join("/");
    }
  }
  const { segments } = parseTopic(effectiveTopic);
  if (segments.length < 4) return false;
  if (!hasKnownPrefix(segments)) return false;
  const channel = segments[2];
  const companyId = segments[3];
  if (companyId !== profile.companyId) return false;

  switch (channel) {
    case "discovery":
      // Allow company-wide discovery wildcard: paperclip/v1/discovery/{companyId}/+/+
      return segments.length === 6;

    case "request":
      // Own inbox: paperclip/v1/request/{companyId}/{ownCircleId}/{agentId}
      // Own pool inbox: paperclip/v1/request/{companyId}/{ownCircleId}/pool/{roleId}
      if (segments.length === 6) {
        return (
          profile.ownCircleIds.includes(segments[4]!) && segments[5] === profile.agentId
        );
      }
      if (segments.length === 7 && segments[5] === "pool") {
        return (
          profile.ownCircleIds.includes(segments[4]!) &&
          profile.ownRoleIds.includes(segments[6]!)
        );
      }
      return false;

    case "reply":
      // Own reply channel: paperclip/v1/reply/{companyId}/{circleId}/{agentId}/+
      if (segments.length !== 7) return false;
      return segments[5] === profile.agentId;

    case "event":
      // Circle event feed (any agent): paperclip/v1/event/{companyId}/{ownCircleId}/+
      if (segments.length !== 6) return false;
      return profile.ownCircleIds.includes(segments[4]!);

    case "crosslink":
      if (segments.length !== 5) return false;
      return profile.crossLinkIds.includes(segments[4]!);

    case "idm":
      // Circle IDM phase feed: paperclip/v1/idm/{companyId}/{ownCircleId}/+/phase
      if (segments.length !== 7) return false;
      if (segments[6] !== "phase") return false;
      return profile.ownCircleIds.includes(segments[4]!);

    // Phase 1.8 — host heartbeat broadcast (every agent in the company).
    case "heartbeat":
      // paperclip/v1/heartbeat/{companyId}
      return segments.length === 4;

    // Phase 1.9 — retained Company DNA envelope (universal within company).
    case "dna":
      // paperclip/v1/dna/{companyId}
      return segments.length === 4;

    // Phase 1.10 — role pool + role broadcast. Both require the agent to
    // hold the role. Topic shape:
    //   paperclip/v1/role/{companyId}/{circleId}/{roleId}            [6 segs]
    //   paperclip/v1/role/{companyId}/{circleId}/{roleId}/broadcast  [7 segs]
    case "role":
      if (segments.length === 6) {
        return (
          profile.ownCircleIds.includes(segments[4]!) &&
          profile.ownRoleIds.includes(segments[5]!)
        );
      }
      if (segments.length === 7 && segments[6] === "broadcast") {
        return (
          profile.ownCircleIds.includes(segments[4]!) &&
          profile.ownRoleIds.includes(segments[5]!)
        );
      }
      return false;

    // Phase 1.10 — skill pool + skill broadcast. Cross-circle by design;
    // any agent with the slug in its accountabilities may subscribe.
    case "skill":
      // paperclip/v1/skill/{companyId}/{slug}
      if (segments.length === 5) {
        return profile.ownSkillSlugs.includes(segments[4]!);
      }
      // paperclip/v1/skill/{companyId}/{slug}/broadcast
      if (segments.length === 6 && segments[5] === "broadcast") {
        return profile.ownSkillSlugs.includes(segments[4]!);
      }
      return false;

    // Phase 1.15a — discussion event topic. Subscribe permitted when the
    // agent is a participant in the open discussion identified by contextId.
    case "discussion": {
      // paperclip/v1/discussion/{companyId}/{contextId}
      if (segments.length !== 5) return false;
      const contextId = segments[4]!;
      const allowed = profile.ownDiscussionContextIds.includes(contextId);
      if (!allowed) {
        logger.info(
          {
            agentId: profile.agentId,
            contextId,
            knownContextIds: profile.ownDiscussionContextIds,
          },
          "mqtt-acl: discussion subscribe denied — contextId not in profile",
        );
      }
      return allowed;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

interface MqttAclRequestBody {
  username?: unknown;
  clientid?: unknown;
  action?: unknown;
  topic?: unknown;
}

export function mqttAclRoutes(db: Db) {
  const router = Router();

  router.post("/internal/mqtt-acl", async (req: Request, res: Response) => {
    const body = req.body as MqttAclRequestBody;
    const usernameRaw = typeof body.username === "string" ? body.username : "";
    const topicRaw = typeof body.topic === "string" ? body.topic : "";
    const actionRaw = typeof body.action === "string" ? body.action : "";

    // Host singleton bypass — restricted, not blanket.
    //
    // Threat model: even though the host shares the broker's superuser
    // credentials, leaking that connection (e.g. a vulnerability in
    // server-side code that lets an attacker submit a publish/subscribe on
    // its behalf) must not let the attacker fan out to arbitrary topics
    // outside Paperclip's namespace or to broker-internal control topics
    // we don't intentionally use. Restrict the host's reachable surface to:
    //
    //   - `paperclip/v1/...` (our own namespace; what every projector,
    //     bridge and runtime bridge needs)
    //   - `$SYS/...` (EMQX system topics, used for operator monitoring)
    //
    // Anything else is denied — including bare `paperclip/...` (older or
    // future v-prefixes are not implicitly trusted).
    if (usernameRaw === HOST_MQTT_USERNAME) {
      // Phase 1.16-EMQX E1 — Host also publishes on `$a2a/v1/...` (A2A-spec
      // discovery + event channels). $SYS/* is EMQX-internal monitoring.
      if (
        topicRaw.startsWith("paperclip/v1/") ||
        topicRaw.startsWith("$a2a/v1/") ||
        topicRaw.startsWith("$SYS/")
      ) {
        res.status(200).json({ result: "allow" });
      } else {
        res.status(200).json({ result: "deny" });
      }
      return;
    }

    // Per-agent path.
    const parts = usernameRaw.split("/");
    if (parts.length !== 3) {
      res.status(200).json({ result: "deny" });
      return;
    }
    const [companyId, _circleId, agentId] = parts as [string, string, string];
    if (!UUID_RE.test(companyId) || !UUID_RE.test(agentId)) {
      res.status(200).json({ result: "deny" });
      return;
    }

    try {
      const profile = await getAclProfile(db, companyId, agentId);
      const action = actionRaw.toLowerCase();
      let allowed = false;
      if (action === "publish") {
        allowed = isPublishAllowed(profile, topicRaw);
      } else if (action === "subscribe") {
        allowed = isSubscribeAllowed(profile, topicRaw);
      } else if (action === "all") {
        allowed = isPublishAllowed(profile, topicRaw) || isSubscribeAllowed(profile, topicRaw);
      }
      logger.debug(
        { agentId, action, topic: topicRaw, allowed },
        "mqtt-acl: decision",
      );
      res.status(200).json({ result: allowed ? "allow" : "deny" });
    } catch (err) {
      logger.warn({ err, agentId }, "mqtt-acl: profile load failed");
      res.status(200).json({ result: "deny" });
    }
  });

  return router;
}
