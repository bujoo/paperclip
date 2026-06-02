/**
 * @fileoverview Internal HTTP endpoints used by the MCP server child process
 * to publish A2A messages on behalf of the calling agent.
 *
 * The MCP server can't import `perAgentClientManager.publishAs` directly
 * (different process). These endpoints bridge: MCP receives a tool call,
 * forwards body to `/api/internal/a2a/{publish,request}`, the server-side
 * handler authenticates the calling agent, then publishes via the standard
 * per-agent MQTT client. ACL is enforced by the broker on the per-agent
 * connection, so a compromised MCP key can't publish topics the agent itself
 * isn't authorised for.
 *
 * Endpoints:
 *  - POST /api/internal/a2a/publish — fire-and-forget on any topic the caller
 *    is authorised to publish to.
 *  - POST /api/internal/a2a/request — publish + await reply, with timeout.
 *    Uses the underlying MQTT v5 response-topic + correlation-data round-trip
 *    from `publishRequestAwaitReply`.
 *  - GET /api/internal/a2a/agents — proxy to the EMQX A2A Registry's listing
 *    endpoint (`/api/v5/a2a/agents`). Used by the `a2aDiscoverAgents` MCP tool.
 *
 * @module server/routes/a2a-internal
 */

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { sql, type Db } from "@paperclipai/db";
import { publishRequestAwaitReply, replyTopic } from "@paperclipai/adapter-a2a-mqtt/server";
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
 * Resolve an agent's primary circle (any circle they hold a role in). The
 * per-agent MQTT client identifies with `{companyId}/{circleId}/{agentId}` —
 * we need this circleId to build well-formed reply topics for the caller and
 * request topics for the target.
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

export function a2aInternalRoutes(db: Db) {
  const router = Router();

  /**
   * POST /api/internal/a2a/publish
   *
   * Fire-and-forget publish on any topic the calling agent is authorised to
   * publish to. The broker's ACL enforces topic-level authorisation per the
   * per-agent client identity.
   *
   * Body: { companyId, topic, payload, userProperties? }
   */
  router.post("/internal/a2a/publish", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const topic = requireString(body, "topic");
      const userProperties = optionalUserProperties(body);
      const payload = body.payload;

      const requester = await resolveRequester(db, req, companyId);
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
   * POST /api/internal/a2a/request
   *
   * Publish a request and await a reply, with timeout. Uses MQTT v5
   * response-topic + correlation-data via `publishRequestAwaitReply`.
   *
   * Body: { companyId, requestTopic, payload, contextId?, timeoutMs?,
   *         userProperties? }
   */
  router.post("/internal/a2a/request", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const companyId = requireString(body, "companyId");
      const targetRequestTopic = requireString(body, "requestTopic");
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
   * GET /api/internal/a2a/agents
   *
   * Proxy to EMQX A2A Registry's listing endpoint. Lets agents discover
   * peers + their Agent Cards. Optional filter via query params.
   *
   * Query: ?org_id=...&unit_id=...&skill=...
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
