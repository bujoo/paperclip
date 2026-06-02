/**
 * @fileoverview HTTP tool-execution bridge for hermes_local agents
 *
 * Hermes_local agents run as standalone Python CLI processes that cannot
 * import or RPC into the plugin worker directly. To let them invoke the
 * holacracy plugin's "escalation" tools (raise tension, forward tension,
 * talk-to-agent, ask-skill, broadcast-to-circle) we expose a thin HTTP
 * surface here.
 *
 * Each endpoint takes a JSON body, derives a synthetic `ToolRunContext`
 * from the authenticated agent identity, and dispatches the underlying
 * plugin tool through the standard `PluginToolDispatcher`. The dispatcher
 * routes the call to the holacracy plugin worker over the existing
 * `executeTool` RPC, so the tools' MQTT broadcasts, DB writes, and
 * activity-log entries all behave exactly as if the tool was called from
 * an in-process adapter — no new code paths in the worker.
 *
 * Auth: standard agent API-key (or local-trusted board). The agent's
 * companyId is taken from the authenticated identity and must match the
 * body's `companyId` (cross-tenant calls are rejected with 401/403).
 *
 * @module server/routes/holacracy-bridge
 */

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

const HOLACRACY_PLUGIN_KEY = "paperclipai.plugin-holacracy";

const TOOL = {
  raiseTensionOnBus: `${HOLACRACY_PLUGIN_KEY}:holacracy-raise-tension-on-bus`,
  forwardTension: `${HOLACRACY_PLUGIN_KEY}:holacracy-forward-tension`,
  talkToAgent: `${HOLACRACY_PLUGIN_KEY}:holacracy-talk-to-agent`,
  askSkill: `${HOLACRACY_PLUGIN_KEY}:holacracy-ask-skill`,
  broadcastToCircle: `${HOLACRACY_PLUGIN_KEY}:holacracy-broadcast-to-circle`,
} as const;

export interface ResolvedRequester {
  agentId: string;
  companyId: string;
  runId: string;
  /** Cached most-recent project id for the company (may be a synthetic placeholder). */
  projectId: string;
}

/**
 * Resolve the authenticated requester to an agent identity for the given
 * companyId. Throws an HTTP-shaped error if the actor is not an agent or
 * does not belong to the company.
 *
 * Hermes_local agents always authenticate with an agent API key. The
 * holacracy tool handlers only read `runContext.agentId` and
 * `runContext.companyId`; `runId` and `projectId` are required by the
 * `ToolRunContext` shape but are not used by these specific tools — we
 * fill them with the X-Paperclip-Run-Id header (or a synthetic UUID) and
 * an arbitrary project from the company (or a synthetic UUID if the
 * company has no projects yet).
 */
export async function resolveRequester(
  db: Db,
  req: Request,
  companyId: string,
): Promise<ResolvedRequester> {
  if (req.actor.type !== "agent") {
    throw { status: 401, code: "AGENT_AUTH_REQUIRED", message: "Agent API key required" };
  }
  if (req.actor.companyId !== companyId) {
    throw {
      status: 403,
      code: "COMPANY_MISMATCH",
      message: "Agent key cannot operate across companies",
    };
  }
  const agentId = req.actor.agentId;
  if (!agentId) {
    throw { status: 401, code: "AGENT_AUTH_REQUIRED", message: "Agent identity missing" };
  }

  const runId = req.actor.runId && req.actor.runId.length > 0 ? req.actor.runId : randomUUID();

  // Pick any project in the company (the tools we proxy don't touch the
  // projectId, but ToolRunContext requires one as a UUID).
  let projectId: string;
  try {
    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.companyId, companyId))
      .limit(1);
    projectId = proj?.id ?? randomUUID();
  } catch {
    projectId = randomUUID();
  }

  return { agentId, companyId, runId, projectId };
}

function buildRunContext(requester: ResolvedRequester): ToolRunContext {
  return {
    agentId: requester.agentId,
    runId: requester.runId,
    companyId: requester.companyId,
    projectId: requester.projectId,
  };
}

function requireString(
  body: Record<string, unknown> | undefined,
  field: string,
): string {
  const value = body?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw {
      status: 400,
      code: "VALIDATION_ERROR",
      message: `"${field}" is required and must be a non-empty string`,
    };
  }
  return value;
}

function optionalString(
  body: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw {
      status: 400,
      code: "VALIDATION_ERROR",
      message: `"${field}" must be a string if provided`,
    };
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown> | undefined,
  field: string,
): boolean | undefined {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw {
      status: 400,
      code: "VALIDATION_ERROR",
      message: `"${field}" must be a boolean if provided`,
    };
  }
  return value;
}

function optionalNumber(
  body: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw {
      status: 400,
      code: "VALIDATION_ERROR",
      message: `"${field}" must be a finite number if provided`,
    };
  }
  return value;
}

interface BridgeErrorShape {
  status: number;
  code: string;
  message: string;
}

function isBridgeError(value: unknown): value is BridgeErrorShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function mapWorkerErrorToBridge(err: unknown): BridgeErrorShape {
  if (err instanceof JsonRpcCallError) {
    if (err.code === PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE) {
      return { status: 503, code: "WORKER_UNAVAILABLE", message: err.message };
    }
    if (err.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED) {
      return { status: 403, code: "CAPABILITY_DENIED", message: err.message };
    }
    if (err.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT) {
      return { status: 504, code: "WORKER_TIMEOUT", message: err.message };
    }
    return { status: 502, code: "WORKER_ERROR", message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not registered") || message.includes("not running")) {
    return { status: 503, code: "PLUGIN_NOT_READY", message };
  }
  return { status: 502, code: "BRIDGE_ERROR", message };
}

/**
 * Parse the worker's `ToolResult` envelope. Holacracy tools return their
 * payload inside `content` as a JSON string; if it's not parseable we
 * fall back to the raw string.
 */
function parseToolContent(content: string | undefined): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Wrap an async handler with the standard try/catch + JSON-error shell every
 * bridge endpoint shares. Throwing a `BridgeErrorShape`-like object (or
 * letting one propagate from `mapWorkerErrorToBridge`) becomes a structured
 * `{ error, code }` JSON response with the right status.
 */
function bridge(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

/**
 * Construct the Express router for `/api/holacracy/*` bridge endpoints.
 *
 * Routes provided:
 *
 * | Method | Path                    | Underlying tool                       |
 * |--------|-------------------------|---------------------------------------|
 * | POST   | /holacracy/tensions     | holacracy-raise-tension-on-bus        |
 * | POST   | /holacracy/forward-tension | holacracy-forward-tension          |
 * | POST   | /holacracy/talk-to-agent | holacracy-talk-to-agent              |
 * | POST   | /holacracy/ask-skill    | holacracy-ask-skill                   |
 * | POST   | /holacracy/broadcast    | holacracy-broadcast-to-circle         |
 *
 * Each endpoint requires `Authorization: Bearer <agentApiKey>`. The agent's
 * companyId must match the `companyId` in the request body.
 */
export function holacracyBridgeRoutes(
  db: Db,
  deps: { toolDispatcher: PluginToolDispatcher },
) {
  const router = Router();

  async function executeToolForAgent(
    toolName: string,
    requester: ResolvedRequester,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    const runContext = buildRunContext(requester);
    const tool = deps.toolDispatcher.getTool(toolName);
    if (!tool) {
      throw {
        status: 503,
        code: "TOOL_NOT_REGISTERED",
        message: `Tool "${toolName}" is not registered. Holacracy plugin may not be installed or ready.`,
      };
    }
    try {
      const result = await deps.toolDispatcher.executeTool(toolName, parameters, runContext);
      if (result.result.error) {
        throw {
          status: 400,
          code: "TOOL_ERROR",
          message: result.result.error,
        };
      }
      return parseToolContent(result.result.content);
    } catch (err) {
      if (isBridgeError(err)) throw err;
      throw mapWorkerErrorToBridge(err);
    }
  }

  /**
   * POST /api/holacracy/tensions
   *
   * Raise an operational tension in a circle and broadcast it on the
   * circle's MQTT event topic. Proxies `holacracy-raise-tension-on-bus`.
   */
  router.post("/holacracy/tensions", bridge(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = requireString(body, "companyId");
    const circleId = requireString(body, "circleId");
    const title = requireString(body, "title");
    const tensionBody = requireString(body, "body");
    const severity = optionalString(body, "severity");
    if (severity !== undefined && !["low", "medium", "high"].includes(severity)) {
      throw {
        status: 400,
        code: "VALIDATION_ERROR",
        message: '"severity" must be one of "low", "medium", or "high"',
      };
    }

    const requester = await resolveRequester(db, req, companyId);
    const data = (await executeToolForAgent(TOOL.raiseTensionOnBus, requester, {
      circleId,
      title,
      body: tensionBody,
      ...(severity ? { severity } : {}),
    })) as { tensionId?: string; busPublished?: boolean } | string | null;

    if (data && typeof data === "object" && "tensionId" in data) {
      res.status(200).json({
        tensionId: data.tensionId ?? null,
        broadcast: data.busPublished === true,
      });
      return;
    }
    res.status(200).json({ tensionId: null, broadcast: false, raw: data });
  }));

  /**
   * POST /api/holacracy/forward-tension
   *
   * Forward a tension from its current circle up to the parent circle.
   * Proxies `holacracy-forward-tension`.
   */
  router.post("/holacracy/forward-tension", bridge(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = requireString(body, "companyId");
    const tensionId = requireString(body, "tensionId");
    const context = optionalString(body, "context") ?? "";

    const requester = await resolveRequester(db, req, companyId);
    const data = (await executeToolForAgent(TOOL.forwardTension, requester, {
      tensionId,
      context,
    })) as
      | { forwardedTensionId?: string; targetCircleId?: string; status?: string }
      | string
      | null;

    if (data && typeof data === "object" && ("forwardedTensionId" in data || "targetCircleId" in data)) {
      res.status(200).json({
        forwarded: data.status === "forwarded",
        parentCircleId: data.targetCircleId ?? null,
        forwardedTensionId: data.forwardedTensionId ?? null,
      });
      return;
    }
    res.status(200).json({ forwarded: false, parentCircleId: null, raw: data });
  }));

  // E7 — talk-to-agent / ask-skill / broadcast retired from the HTTP bridge.
  // All agents now run on bedrock_gateway (T0) and reach equivalent A2A
  // primitives directly. We keep the routes registered as 410 Gone responses
  // with a pointer so any straggler external caller gets a clear failure
  // instead of a silent 404.
  const retired = (hint: string) =>
    bridge(async (_req, res) => {
      res.status(410).json({
        error: "Route retired — moved to A2A-over-MQTT (E7)",
        code: "ROUTE_RETIRED",
        hint: `Publish directly per docs/specs/a2a-mqtt-protocol.md, or use MCP tool ${hint} once E8 ships.`,
      });
    });
  router.post("/holacracy/talk-to-agent", retired("mcp__paperclip-mcp__a2aSendTask"));
  router.post("/holacracy/ask-skill", retired("mcp__paperclip-mcp__a2aSendTask (pool variant)"));
  router.post("/holacracy/broadcast", retired("mcp__paperclip-mcp__a2aBroadcastEvent"));

  return router;
}

function sendError(res: Response, err: unknown): void {
  if (isBridgeError(err)) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message, code: "INTERNAL_ERROR" });
}
