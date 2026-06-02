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
import * as perAgentClientManager from "../mqtt/per-agent-client-manager.js";
import { logger } from "../middleware/logger.js";
import { resolveRequester } from "./holacracy-bridge.js";

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

export function a2aInternalRoutes(db: Db) {
  const router = Router();

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

  return router;
}
