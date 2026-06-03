/**
 * @fileoverview Internal HTTP endpoints used by the MCP server child process
 * to publish A2A messages on behalf of the calling agent.
 *
 * The MCP server can't import `perAgentClientManager.publishAs` directly
 * (different process). The MCP tool sends semantic args (`toAgentId`,
 * `circleId`, `roleId`, etc.); these endpoints build the actual MQTT topic
 * server-side using the adapter's topic builders, then publish via the
 * standard per-agent MQTT client. Broker ACL enforces topic-level
 * authorisation per the per-agent connection.
 *
 * Endpoints:
 *  - POST /api/internal/a2a/publish — fire-and-forget. `kind` selects the
 *    topic dimension (self-event / circle-event / role-broadcast /
 *    skill-broadcast).
 *  - POST /api/internal/a2a/request — publish + await reply with timeout.
 *    `kind` selects the target dimension (agent / role-pool / skill-pool).
 *  - GET /api/internal/a2a/agents — proxy to EMQX A2A Registry.
 *
 * @module server/routes/a2a-internal
 */

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { sql, type Db } from "@paperclipai/db";
import {
  publishRequestAwaitReply,
  replyTopic,
  requestTopic,
  poolRequestTopic,
  eventTopic,
  roleBroadcastTopic,
  rolePoolTopic,
  skillPoolTopic,
  skillBroadcastTopic,
} from "@paperclipai/adapter-a2a-mqtt/server";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import * as perAgentClientManager from "../mqtt/per-agent-client-manager.js";
import { logger } from "../middleware/logger.js";
import { resolveRequester, type ResolvedRequester } from "./holacracy-bridge.js";
import { upsertTrustSignal } from "../services/trust-signals.js";
import {
  semanticSkillSearch,
  findCandidateAgentsForSkill,
} from "../services/skill-index.js";
import {
  agentTrustScore,
  TRUST_THRESHOLD,
  ENDORSER_MIN_TRUST,
  ENDORSEMENT_TARGET_TYPE,
  ENDORSEMENT_VOTE,
  endorsementTargetId,
  encodeEndorsementAuthor,
} from "../services/trust-score.js";
import { logActivity } from "../services/activity-log.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

const HOLACRACY_RAISE_TENSION_TOOL =
  "paperclipai.plugin-holacracy:holacracy-raise-tension-on-bus";

interface ErrorShape {
  status: number;
  code: string;
  message: string;
}

function isErrorShape(value: unknown): value is ErrorShape {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as { status?: unknown }).status === "number"
    && typeof (value as { code?: unknown }).code === "string"
    && typeof (value as { message?: unknown }).message === "string"
  );
}

function sendError(res: Response, err: unknown): void {
  if (isErrorShape(err)) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message, code: "INTERNAL_ERROR" });
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw { status: 400, code: "VALIDATION_ERROR", message: `"${field}" required` };
  }
  return v;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw { status: 400, code: "VALIDATION_ERROR", message: `"${field}" must be a string` };
  }
  return v;
}

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw { status: 400, code: "VALIDATION_ERROR", message: `"${field}" must be a finite number` };
  }
  return v;
}

function optionalUserProperties(body: Record<string, unknown>): Record<string, string> | undefined {
  const v = body.userProperties;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw { status: 400, code: "VALIDATION_ERROR", message: '"userProperties" must be an object' };
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw {
        status: 400,
        code: "VALIDATION_ERROR",
        message: `userProperties.${k} must be a string`,
      };
    }
    out[k] = val;
  }
  return out;
}

/**
 * Resolve an agent's primary circle. The per-agent MQTT client identifies
 * with `{companyId}/{circleId}/{agentId}` — we need this circleId to build
 * well-formed reply topics for the caller and event topics scoped to the
 * caller's home circle.
 */
async function resolvePrimaryCircle(db: Db, agentId: string): Promise<string | null> {
  try {
    const rows = await db.execute<{ circle_id: string }>(sql.raw(`
      SELECT r.circle_id::text AS circle_id
        FROM plugin_holacracy_c5049b5dfe.role_assignments ra
        JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
       WHERE ra.agent_id = '${agentId}'::uuid
       ORDER BY ra.assigned_at ASC NULLS LAST
       LIMIT 1
    `));
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows?: typeof rows }).rows ?? [];
    const first = (list as Array<{ circle_id: string }>)[0];
    return first?.circle_id ?? null;
  } catch (err) {
    logger.debug({ err, agentId }, "a2a-internal: primary-circle lookup failed");
    return null;
  }
}

type PublishKind = "event-self" | "event-circle" | "role-broadcast" | "skill-broadcast";
type RequestKind = "agent" | "role-pool" | "skill-pool";

export interface A2aInternalDeps {
  /** Optional plugin tool dispatcher — when present, decline can raise a holacracy tension. */
  toolDispatcher?: PluginToolDispatcher;
}

export function a2aInternalRoutes(db: Db, deps: A2aInternalDeps = {}) {
  const router = Router();

  /**
   * Best-effort: load an issue's companyId + assigneeAgentId + title for
   * the decline endpoint. Returns null if the row is missing or belongs
   * to another company.
   */
  async function loadIssueForCompany(
    issueId: string,
    companyId: string,
  ): Promise<{ id: string; companyId: string; title: string; assigneeAgentId: string | null } | null> {
    try {
      const rows = await db.execute<{
        id: string;
        company_id: string;
        title: string;
        assignee_agent_id: string | null;
      }>(sql`
        SELECT id::text          AS id,
               company_id::text  AS company_id,
               title             AS title,
               assignee_agent_id::text AS assignee_agent_id
          FROM public.issues
         WHERE id = ${issueId}::uuid
         LIMIT 1
      `);
      const list = Array.isArray(rows)
        ? rows
        : (rows as unknown as { rows?: typeof rows }).rows ?? [];
      const first = (list as Array<{
        id: string;
        company_id: string;
        title: string;
        assignee_agent_id: string | null;
      }>)[0];
      if (!first) return null;
      if (first.company_id !== companyId) return null;
      return {
        id: first.id,
        companyId: first.company_id,
        title: first.title,
        assigneeAgentId: first.assignee_agent_id,
      };
    } catch (err) {
      logger.debug({ err, issueId, companyId }, "a2a-internal: loadIssueForCompany failed");
      return null;
    }
  }

  async function insertIssueComment(
    companyId: string,
    issueId: string,
    agentId: string,
    body: string,
  ): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO public.issue_comments (company_id, issue_id, author_agent_id, body)
        VALUES (${companyId}::uuid, ${issueId}::uuid, ${agentId}::uuid, ${body})
      `);
    } catch (err) {
      logger.warn({ err, issueId }, "a2a-internal: failed to insert decline comment (best-effort)");
    }
  }

  function buildRunContext(requester: ResolvedRequester): ToolRunContext {
    return {
      agentId: requester.agentId,
      runId: requester.runId,
      companyId: requester.companyId,
      projectId: requester.projectId,
    };
  }

  /**
   * POST /api/internal/a2a/publish — fire-and-forget on a topic the server
   * builds from semantic args. The MCP tool layer is the only normal caller.
   *
   * Body shape varies by `kind`:
   *  - { kind: "event-self", payload, userProperties? }
   *  - { kind: "event-circle", circleId, payload, userProperties? }
   *  - { kind: "role-broadcast", circleId, roleId, payload, userProperties? }
   *  - { kind: "skill-broadcast", skill, payload, userProperties? }
   */
  router.post("/internal/a2a/publish", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const kind = requireString(body, "kind") as PublishKind;
      const userProperties = optionalUserProperties(body);
      const payload = body.payload;

      const requester = await resolveRequester(db, req, companyId);
      let topic: string;
      switch (kind) {
        case "event-self": {
          const callerCircle = await resolvePrimaryCircle(db, requester.agentId);
          if (!callerCircle) {
            throw {
              status: 400,
              code: "NO_PRIMARY_CIRCLE",
              message: "Caller agent has no role assignment; cannot build event topic",
            };
          }
          topic = eventTopic(companyId, callerCircle, requester.agentId);
          break;
        }
        case "event-circle": {
          const circleId = requireString(body, "circleId");
          topic = eventTopic(companyId, circleId, requester.agentId);
          break;
        }
        case "role-broadcast": {
          const circleId = requireString(body, "circleId");
          const roleId = requireString(body, "roleId");
          topic = roleBroadcastTopic(companyId, circleId, roleId);
          break;
        }
        case "skill-broadcast": {
          const skill = requireString(body, "skill");
          topic = skillBroadcastTopic(companyId, skill);
          break;
        }
        default:
          throw {
            status: 400,
            code: "VALIDATION_ERROR",
            message: `Unknown publish kind: ${kind}`,
          };
      }

      await perAgentClientManager.publishAs(requester.agentId, topic, payload, {
        qos: 1,
        ...(userProperties ? { userProperties } : {}),
      });
      res.status(200).json({
        published: true,
        topic,
        agentId: requester.agentId,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * POST /api/internal/a2a/request — publish + await reply, with timeout.
   *
   * Body shape varies by `kind`:
   *  - { kind: "agent", toAgentId, payload, contextId?, timeoutMs?, userProperties? }
   *  - { kind: "role-pool", circleId, roleId, payload, contextId?, timeoutMs?, userProperties? }
   *  - { kind: "skill-pool", skill, payload, contextId?, timeoutMs?, userProperties? }
   *
   * For role-pool/skill-pool: the broker round-robins to ONE filler via
   * shared subscription on the target side; the request itself publishes
   * on the un-shared topic.
   */
  router.post("/internal/a2a/request", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const kind = requireString(body, "kind") as RequestKind;
      const contextId = optionalString(body, "contextId");
      const timeoutMs = optionalNumber(body, "timeoutMs") ?? 60_000;
      const extraUserProperties = optionalUserProperties(body) ?? {};
      const payload = body.payload;

      const requester = await resolveRequester(db, req, companyId);
      const callerCircle = await resolvePrimaryCircle(db, requester.agentId);
      if (!callerCircle) {
        throw {
          status: 400,
          code: "NO_PRIMARY_CIRCLE",
          message: "Caller agent has no role assignment; cannot construct reply topic",
        };
      }

      let targetRequestTopic: string;
      // T1 — directTargetAgentId is set only for kind==="agent"; pool dispatch
      // resolves the responder after the fact (via a2a-responder-agent-id user
      // property on the reply). For trust-signal writes we only credit/debit
      // when we know the specific target.
      let directTargetAgentId: string | null = null;
      switch (kind) {
        case "agent": {
          const toAgentId = requireString(body, "toAgentId");
          const targetCircle = await resolvePrimaryCircle(db, toAgentId);
          if (!targetCircle) {
            throw {
              status: 400,
              code: "TARGET_NO_PRIMARY_CIRCLE",
              message: `Target agent ${toAgentId} has no role assignment`,
            };
          }
          targetRequestTopic = requestTopic(companyId, targetCircle, toAgentId);
          directTargetAgentId = toAgentId;
          break;
        }
        case "role-pool": {
          const circleId = requireString(body, "circleId");
          const roleId = requireString(body, "roleId");
          // Use poolRequestTopic for spec-compliant A2A pool dispatch.
          // Receivers subscribe via $share/role-{roleId}/<topic>.
          targetRequestTopic = poolRequestTopic(companyId, circleId, roleId);
          // Also include the legacy rolePoolTopic for any subscribers still
          // on the Paperclip-prefixed topology (best-effort; ignore failure).
          void rolePoolTopic; // keep import warm
          break;
        }
        case "skill-pool": {
          const skill = requireString(body, "skill");
          targetRequestTopic = skillPoolTopic(companyId, skill);
          break;
        }
        default:
          throw {
            status: 400,
            code: "VALIDATION_ERROR",
            message: `Unknown request kind: ${kind}`,
          };
      }

      const taskId = randomUUID();
      const callerReplyTopic = replyTopic(companyId, callerCircle, requester.agentId, taskId);

      const client = perAgentClientManager.tryGetClient(requester.agentId);
      if (!client) {
        throw {
          status: 503,
          code: "NO_PER_AGENT_CLIENT",
          message: `Per-agent MQTT client not connected for ${requester.agentId}`,
        };
      }

      try {
        const reply = await publishRequestAwaitReply(client, {
          requestTopic: targetRequestTopic,
          replyTopic: callerReplyTopic,
          payload,
          timeoutMs,
          contentType: "application/json",
          qos: 1,
          userProperties: {
            "a2a-task-id": taskId,
            "a2a-task-context-id": contextId ?? taskId,
            "a2a-context-id": contextId ?? taskId,
            "a2a-content": "task",
            "a2a-status-source": "agent",
            ...extraUserProperties,
          },
        });
        // T1 — record successful trust signal (I1 regression fix).
        // For directed (kind="agent") requests, the responder is known;
        // credit them. For pool dispatch, the responder MAY be carried in
        // a2a-responder-agent-id user property on the reply — use that
        // when present.
        const respondedByFromUserProps = reply.userProperties?.["a2a-responder-agent-id"];
        const responderAgentId = directTargetAgentId
          ?? (typeof respondedByFromUserProps === "string" ? respondedByFromUserProps : null);
        if (responderAgentId) {
          await upsertTrustSignal(db, requester.agentId, responderAgentId, "general", true);
        }
        res.status(200).json({
          taskId,
          contextId: contextId ?? taskId,
          requestTopic: targetRequestTopic,
          awaited: true,
          timedOut: false,
          reply: reply.payload,
          replyUserProperties: reply.userProperties,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("timed out")) {
          // T1 — record failed trust signal on timeout (I1 regression fix).
          // Only when we know the specific target (directed kind="agent");
          // pool dispatch timeouts don't have a single agent to debit.
          if (directTargetAgentId) {
            await upsertTrustSignal(db, requester.agentId, directTargetAgentId, "general", false);
          }
          res.status(200).json({
            taskId,
            contextId: contextId ?? taskId,
            requestTopic: targetRequestTopic,
            awaited: true,
            timedOut: true,
            reply: null,
          });
          return;
        }
        throw err;
      }
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * GET /api/internal/a2a/agents — proxy to EMQX A2A Registry.
   */
  router.get("/internal/a2a/agents", async (req, res) => {
    try {
      const baseUrl =
        process.env.PAPERCLIP_EMQX_DASHBOARD_URL?.trim()
        || "http://localhost:18083";
      const user = process.env.PAPERCLIP_EMQX_DASHBOARD_USER?.trim() || "admin";
      const pass = process.env.PAPERCLIP_EMQX_DASHBOARD_PASSWORD?.trim() || "public";
      const params = new URLSearchParams();
      for (const key of ["org_id", "unit_id", "agent_id", "skill"]) {
        const v = req.query[key];
        if (typeof v === "string" && v.length > 0) params.set(key, v);
      }
      const qs = params.toString();
      const url = `${baseUrl}/api/v5/a2a/agents${qs ? `?${qs}` : ""}`;
      const auth = Buffer.from(`${user}:${pass}`).toString("base64");
      const upstream = await fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        res.status(502).json({
          error: `EMQX Registry returned ${upstream.status}`,
          code: "REGISTRY_ERROR",
          detail: text.slice(0, 500),
        });
        return;
      }
      const data = await upstream.json();
      res.status(200).json(data);
    } catch (err) {
      logger.warn({ err }, "GET /internal/a2a/agents failed");
      sendError(res, err);
    }
  });

  /**
   * POST /api/internal/skill-index/search — semantic skill discovery.
   *
   * Body: { companyId, query, topK? } (topK defaults to 5).
   *
   * Returns top-K SKILL.md chunks whose vector embeddings (Bedrock
   * Cohere) most closely match the query. Each result is enriched with
   * candidate agents (those whose role accountabilities mention the
   * skill slug) and their aggregate trust scores. Use this BEFORE
   * a2aSendTask to find the right peer for a task.
   */
  router.post("/internal/skill-index/search", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const query = requireString(body, "query");
      const topKRaw = body.topK;
      const topK = typeof topKRaw === "number" && Number.isFinite(topKRaw) && topKRaw > 0
        ? Math.min(20, Math.floor(topKRaw))
        : 5;

      // Auth: same per-agent gate as the other internal endpoints.
      await resolveRequester(db, req, companyId);

      const matches = await semanticSkillSearch(db, companyId, query, topK);

      // Deduplicate candidate-agent lookups by skillSlug (multiple chunks
      // from the same skill share the same candidate pool).
      const candidatesBySlug = new Map<string, Awaited<ReturnType<typeof findCandidateAgentsForSkill>>>();
      for (const match of matches) {
        if (candidatesBySlug.has(match.skillSlug)) continue;
        candidatesBySlug.set(
          match.skillSlug,
          await findCandidateAgentsForSkill(db, companyId, match.skillSlug),
        );
      }

      const results = matches.map((match) => ({
        skillId: match.skillId,
        skillSlug: match.skillSlug,
        skillName: match.skillName,
        chunkIndex: match.chunkIndex,
        chunkText: match.chunkText,
        semanticDistance: match.semanticDistance,
        candidateAgents: candidatesBySlug.get(match.skillSlug) ?? [],
      }));

      res.status(200).json({ results });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * POST /api/internal/skill-fit/check — answer "do I have the trust
   * needed for this task on each required skill?".
   *
   * Body: { companyId, taskDescription, candidateAgentId?, requiredSkills? }
   *
   * If `requiredSkills` is omitted, the server infers it via a top-3
   * semantic search against the company's SKILL.md catalog. For each
   * skill we compute `agentTrustScore` for the candidate (or the caller
   * when `candidateAgentId` is missing) and partition into `have` vs
   * `missing` against `TRUST_THRESHOLD`. We also list suggested
   * alternative agents drawn from `findCandidateAgentsForSkill`.
   */
  router.post("/internal/skill-fit/check", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const taskDescription = requireString(body, "taskDescription");
      const candidateAgentIdInput = optionalString(body, "candidateAgentId");
      const requiredSkillsRaw = body.requiredSkills;

      const requester = await resolveRequester(db, req, companyId);
      const candidateAgentId = candidateAgentIdInput ?? requester.agentId;

      // Resolve the required-skills set.
      let requiredSkills: string[];
      let inferred = false;
      if (Array.isArray(requiredSkillsRaw) && requiredSkillsRaw.length > 0) {
        const sanitised = requiredSkillsRaw
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim());
        if (sanitised.length === 0) {
          throw {
            status: 400,
            code: "VALIDATION_ERROR",
            message: '"requiredSkills" must contain at least one non-empty string',
          };
        }
        requiredSkills = Array.from(new Set(sanitised));
      } else {
        inferred = true;
        const matches = await semanticSkillSearch(db, companyId, taskDescription, 6);
        const seen = new Set<string>();
        requiredSkills = [];
        for (const match of matches) {
          if (seen.has(match.skillSlug)) continue;
          seen.add(match.skillSlug);
          requiredSkills.push(match.skillSlug);
          if (requiredSkills.length >= 3) break;
        }
      }

      const have: Array<{
        skill: string;
        trustScore: number;
        isInGrace: boolean;
        basedOn: string;
      }> = [];
      const missing: Array<{
        skill: string;
        trustScore: number;
        isInGrace: boolean;
        basedOn: string;
        requiredThreshold: number;
      }> = [];
      const suggestedAlternatives: Array<{
        agentId: string;
        agentName: string | null;
        skill: string;
        trustScore: number | null;
      }> = [];

      for (const skill of requiredSkills) {
        const score = await agentTrustScore(db, candidateAgentId, skill);
        const meets = score.score >= TRUST_THRESHOLD || score.isInGrace;
        if (meets) {
          have.push({
            skill,
            trustScore: score.score,
            isInGrace: score.isInGrace,
            basedOn: score.basedOn,
          });
        } else {
          missing.push({
            skill,
            trustScore: score.score,
            isInGrace: score.isInGrace,
            basedOn: score.basedOn,
            requiredThreshold: TRUST_THRESHOLD,
          });
          // Look up alternative fillers for the missing skill.
          const candidates = await findCandidateAgentsForSkill(db, companyId, skill);
          for (const c of candidates) {
            if (c.agentId === candidateAgentId) continue;
            // Filter to candidates who clear the threshold.
            if (c.trustScore !== null && c.trustScore < TRUST_THRESHOLD) continue;
            suggestedAlternatives.push({
              agentId: c.agentId,
              agentName: c.agentName,
              skill,
              trustScore: c.trustScore,
            });
          }
        }
      }

      res.status(200).json({
        candidateAgentId,
        requiredSkills,
        requiredSkillsInferred: inferred,
        have,
        missing,
        suggestedAlternatives,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * POST /api/internal/a2a/decline — agent declines an assigned task.
   *
   * Body:
   *  - { companyId, taskId, declineKind: "skill-trust-below-threshold",
   *      trustScore?, missingSkills? }
   *  - { companyId, taskId, declineKind: "scope-ambiguous",
   *      clarifyingQuestions: string[] }
   *  - { companyId, taskId, declineKind: "wrong-role" }
   *
   * Side effects vary by `declineKind`:
   *  - skill-trust-below-threshold → issue.status=blocked + comment +
   *    raise a holacracy tension (best-effort) so the lead-link can route.
   *  - scope-ambiguous → create an `ask_user_questions` interaction with
   *    the clarifying questions + mark issue blocked pending answer.
   *  - wrong-role → clear assigneeAgentId + comment + activity log.
   */
  router.post("/internal/a2a/decline", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const taskId = requireString(body, "taskId");
      const declineKindRaw = requireString(body, "declineKind");
      const allowed = ["skill-trust-below-threshold", "scope-ambiguous", "wrong-role"] as const;
      type DeclineKind = (typeof allowed)[number];
      if (!(allowed as readonly string[]).includes(declineKindRaw)) {
        throw {
          status: 400,
          code: "VALIDATION_ERROR",
          message: `"declineKind" must be one of ${allowed.join(", ")}`,
        };
      }
      const declineKind = declineKindRaw as DeclineKind;
      const trustScore = optionalNumber(body, "trustScore");

      const requester = await resolveRequester(db, req, companyId);
      const issue = await loadIssueForCompany(taskId, companyId);
      if (!issue) {
        throw {
          status: 404,
          code: "ISSUE_NOT_FOUND",
          message: `Issue ${taskId} not found in company ${companyId}`,
        };
      }

      const sideEffects: string[] = [];

      if (declineKind === "skill-trust-below-threshold") {
        const missingSkillsRaw = body.missingSkills;
        const missingSkills = Array.isArray(missingSkillsRaw)
          ? missingSkillsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          : [];

        try {
          await db.execute(sql`
            UPDATE public.issues
               SET status = 'blocked',
                   updated_at = NOW()
             WHERE id = ${taskId}::uuid
          `);
          sideEffects.push("issue.status=blocked");
        } catch (err) {
          logger.warn({ err, taskId }, "a2a-internal: decline failed to mark issue blocked");
        }

        const trustText = trustScore !== undefined
          ? ` (trust=${trustScore.toFixed(2)}, threshold=${TRUST_THRESHOLD})`
          : "";
        const skillsText = missingSkills.length > 0
          ? ` Missing: ${missingSkills.join(", ")}.`
          : "";
        const comment =
          `Declining this task: skill trust below threshold${trustText}.${skillsText}` +
          " Raising a tension so the Lead Link can re-route.";
        await insertIssueComment(companyId, taskId, requester.agentId, comment);
        sideEffects.push("comment.posted");

        // Best-effort: raise a tension via the holacracy plugin worker on
        // the caller's primary circle (the lead-link of that circle is
        // the standard escalation target). Fail open if the plugin is
        // unavailable — the comment + activity log are the durable record.
        const callerCircle = await resolvePrimaryCircle(db, requester.agentId);
        if (deps.toolDispatcher && callerCircle) {
          try {
            const tool = deps.toolDispatcher.getTool(HOLACRACY_RAISE_TENSION_TOOL);
            if (tool) {
              const tensionBody =
                `Agent ${requester.agentId} declined task "${issue.title}" (${taskId})` +
                ` due to skill-trust below ${TRUST_THRESHOLD}${trustText}.` +
                (missingSkills.length > 0 ? ` Missing skills: ${missingSkills.join(", ")}.` : "") +
                " Lead Link: please reassign to a qualified filler.";
              await deps.toolDispatcher.executeTool(
                HOLACRACY_RAISE_TENSION_TOOL,
                {
                  circleId: callerCircle,
                  title: `Skill-trust decline: ${issue.title}`,
                  body: tensionBody,
                  severity: "medium",
                },
                buildRunContext(requester),
              );
              sideEffects.push("tension.raised");
            }
          } catch (err) {
            logger.warn({ err, taskId, circleId: callerCircle }, "a2a-internal: tension raise failed");
          }
        }

        await logActivity(db, {
          companyId,
          actorType: "agent",
          actorId: requester.agentId,
          agentId: requester.agentId,
          action: "issue.declined",
          entityType: "issue",
          entityId: taskId,
          details: {
            declineKind,
            trustScore: trustScore ?? null,
            missingSkills,
          },
        }).catch((err) => {
          logger.debug({ err }, "a2a-internal: activity log (decline) failed");
        });

        res.status(200).json({ ok: true, declineKind, sideEffects });
        return;
      }

      if (declineKind === "scope-ambiguous") {
        const clarifyingQuestionsRaw = body.clarifyingQuestions;
        if (!Array.isArray(clarifyingQuestionsRaw) || clarifyingQuestionsRaw.length === 0) {
          throw {
            status: 400,
            code: "VALIDATION_ERROR",
            message: '"clarifyingQuestions" must be a non-empty array of strings',
          };
        }
        const questions = clarifyingQuestionsRaw
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .slice(0, 10);
        if (questions.length === 0) {
          throw {
            status: 400,
            code: "VALIDATION_ERROR",
            message: '"clarifyingQuestions" must contain at least one non-empty string',
          };
        }

        // Mark blocked pending answer.
        try {
          await db.execute(sql`
            UPDATE public.issues
               SET status = 'blocked',
                   updated_at = NOW()
             WHERE id = ${taskId}::uuid
          `);
          sideEffects.push("issue.status=blocked");
        } catch (err) {
          logger.warn({ err, taskId }, "a2a-internal: decline failed to mark scope-ambiguous issue blocked");
        }

        const payload = {
          version: 1 as const,
          title: "Clarifying questions",
          submitLabel: "Submit answers",
          questions: questions.map((prompt, i) => ({
            id: `q${i + 1}`,
            prompt: prompt.length > 500 ? prompt.slice(0, 500) : prompt,
            selectionMode: "single" as const,
            required: true,
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          })),
        };

        try {
          await db.execute(sql`
            INSERT INTO public.issue_thread_interactions
              (company_id, issue_id, kind, status, continuation_policy, payload, created_by_agent_id)
            VALUES
              (${companyId}::uuid, ${taskId}::uuid, 'ask_user_questions', 'pending', 'wake_assignee',
               ${JSON.stringify(payload)}::jsonb, ${requester.agentId}::uuid)
          `);
          sideEffects.push("interaction.ask_user_questions.created");
        } catch (err) {
          logger.warn({ err, taskId }, "a2a-internal: failed to create ask_user_questions interaction");
        }

        await insertIssueComment(
          companyId,
          taskId,
          requester.agentId,
          `Declining as scope is ambiguous; posted ${questions.length} clarifying question(s).`,
        );
        sideEffects.push("comment.posted");

        await logActivity(db, {
          companyId,
          actorType: "agent",
          actorId: requester.agentId,
          agentId: requester.agentId,
          action: "issue.declined",
          entityType: "issue",
          entityId: taskId,
          details: { declineKind, clarifyingQuestions: questions },
        }).catch((err) => {
          logger.debug({ err }, "a2a-internal: activity log (decline scope) failed");
        });

        res.status(200).json({ ok: true, declineKind, sideEffects });
        return;
      }

      // wrong-role
      try {
        await db.execute(sql`
          UPDATE public.issues
             SET assignee_agent_id = NULL,
                 updated_at        = NOW()
           WHERE id = ${taskId}::uuid
        `);
        sideEffects.push("issue.assignee=null");
      } catch (err) {
        logger.warn({ err, taskId }, "a2a-internal: decline (wrong-role) failed to clear assignee");
      }
      await insertIssueComment(
        companyId,
        taskId,
        requester.agentId,
        "Out-of-role decline; needs Lead Link routing.",
      );
      sideEffects.push("comment.posted");
      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: requester.agentId,
        agentId: requester.agentId,
        action: "issue.declined",
        entityType: "issue",
        entityId: taskId,
        details: { declineKind },
      }).catch((err) => {
        logger.debug({ err }, "a2a-internal: activity log (decline wrong-role) failed");
      });

      res.status(200).json({ ok: true, declineKind, sideEffects });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * POST /api/internal/a2a/endorse — caller endorses another agent's
   * skill. Requires the caller to clear `ENDORSER_MIN_TRUST` (0.85) on
   * the same skill, so endorsements compound from established trust.
   *
   * Body: { companyId, targetAgentId, skillSlug, rationale }
   *
   * Stored as a row in `public.feedback_votes` with
   * `target_type='agent_skill_endorsement'`, `vote='endorsed'`. We need
   * an `issue_id` (NOT NULL FK) — `feedback_votes.issue_id` is used as
   * the originating context, so we use the requester's
   * `ResolvedRequester.projectId` to find a recent issue, falling back
   * to any company-scoped issue. If no issue exists for the company, the
   * endorsement is rejected (endorsements outside any operational
   * context are not currently supported by the schema).
   */
  router.post("/internal/a2a/endorse", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const targetAgentId = requireString(body, "targetAgentId");
      const skillSlug = requireString(body, "skillSlug").trim().toLowerCase();
      const rationale = requireString(body, "rationale");

      const requester = await resolveRequester(db, req, companyId);
      if (targetAgentId === requester.agentId) {
        throw {
          status: 400,
          code: "SELF_ENDORSEMENT",
          message: "You cannot endorse yourself",
        };
      }

      // Gate: caller must clear ENDORSER_MIN_TRUST on this skill.
      const callerScore = await agentTrustScore(db, requester.agentId, skillSlug);
      if (callerScore.score < ENDORSER_MIN_TRUST) {
        throw {
          status: 403,
          code: "ENDORSER_BELOW_THRESHOLD",
          message:
            `Your trust on "${skillSlug}" is ${callerScore.score.toFixed(2)}; endorsement requires >= ${ENDORSER_MIN_TRUST}`,
        };
      }

      // Resolve an issue id to satisfy the NOT NULL FK on feedback_votes.issue_id.
      let issueId: string | null = null;
      try {
        const rows = await db.execute<{ id: string }>(sql`
          SELECT id::text AS id
            FROM public.issues
           WHERE company_id = ${companyId}::uuid
           ORDER BY created_at DESC
           LIMIT 1
        `);
        const list = Array.isArray(rows) ? rows : (rows as unknown as { rows?: typeof rows }).rows ?? [];
        const first = (list as Array<{ id: string }>)[0];
        issueId = first?.id ?? null;
      } catch (err) {
        logger.debug({ err, companyId }, "a2a-internal: endorse issue lookup failed");
      }
      if (!issueId) {
        throw {
          status: 409,
          code: "NO_ISSUE_CONTEXT",
          message: "Endorsements require at least one issue in the company to anchor the vote",
        };
      }

      const targetId = endorsementTargetId(targetAgentId, skillSlug);
      const authorEncoded = encodeEndorsementAuthor(requester.agentId);

      try {
        await db.execute(sql`
          INSERT INTO public.feedback_votes
            (company_id, issue_id, target_type, target_id, author_user_id, vote, reason)
          VALUES
            (${companyId}::uuid, ${issueId}::uuid, ${ENDORSEMENT_TARGET_TYPE},
             ${targetId}, ${authorEncoded}, ${ENDORSEMENT_VOTE}, ${rationale})
          ON CONFLICT (company_id, target_type, target_id, author_user_id) DO UPDATE
            SET vote = EXCLUDED.vote,
                reason = EXCLUDED.reason,
                updated_at = NOW()
        `);
      } catch (err) {
        logger.warn({ err, targetAgentId, skillSlug }, "a2a-internal: endorse UPSERT failed");
        throw {
          status: 500,
          code: "ENDORSEMENT_WRITE_FAILED",
          message: "Failed to persist endorsement",
        };
      }

      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: requester.agentId,
        agentId: requester.agentId,
        action: "agent.endorsed",
        entityType: "agent",
        entityId: targetAgentId,
        details: { skillSlug, rationale, callerTrust: callerScore.score },
      }).catch((err) => {
        logger.debug({ err }, "a2a-internal: activity log (endorse) failed");
      });

      // Recompute target's trust after the endorsement is in place.
      const endorsedTrustScore = await agentTrustScore(db, targetAgentId, skillSlug);

      res.status(200).json({
        ok: true,
        endorsedTrustScore: endorsedTrustScore.score,
        endorsedBy: endorsedTrustScore.endorsedBy,
        basedOn: endorsedTrustScore.basedOn,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
