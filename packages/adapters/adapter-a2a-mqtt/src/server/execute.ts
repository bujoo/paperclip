import { randomUUID } from "node:crypto";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  createA2AClient,
  publishRequestAwaitReply,
  type A2AClientConfig,
} from "./client.js";
import {
  replyTopic as buildReplyTopic,
  requestTopic as buildRequestTopic,
  poolRequestTopic as buildPoolRequestTopic,
} from "./topics.js";

interface ResolvedTarget {
  brokerUrl: string;
  companyId: string;
  circleId: string;
  agentId: string;
  /** When set, request is dispatched to the pool topic for this role instead of the per-agent topic. */
  poolRoleId: string | null;
  username: string | null;
  password: string | null;
  timeoutMs: number;
}

function resolveTarget(ctx: AdapterExecutionContext): ResolvedTarget {
  const config = parseObject(ctx.config);
  const brokerUrl = asString(config.brokerUrl, "").trim();
  if (!brokerUrl) {
    throw new Error(
      "adapter-a2a-mqtt: adapterConfig.brokerUrl is required (e.g. mqtt://localhost:1883)",
    );
  }

  const companyId =
    asString(config.companyId, "").trim() ||
    asString((ctx.agent as { companyId?: unknown }).companyId, "").trim();
  const circleId = asString(config.circleId, "").trim();
  const agentId =
    asString(config.agentId, "").trim() || asString(ctx.agent.id, "").trim();
  const poolRoleId = asString(config.poolRoleId, "").trim() || null;

  if (!companyId) {
    throw new Error("adapter-a2a-mqtt: companyId could not be resolved from config or agent");
  }
  if (!circleId) {
    throw new Error("adapter-a2a-mqtt: adapterConfig.circleId is required");
  }
  if (!agentId) {
    throw new Error("adapter-a2a-mqtt: agentId could not be resolved from config or agent");
  }

  const username = asString(config.username, "").trim() || null;
  const password = asString(config.password, "").trim() || null;
  const timeoutSec = asNumber(config.timeoutSec, 60);
  const timeoutMs = Math.max(1, Math.floor(timeoutSec * 1000));

  return {
    brokerUrl,
    companyId,
    circleId,
    agentId,
    poolRoleId,
    username,
    password,
    timeoutMs,
  };
}

function extractPrompt(ctx: AdapterExecutionContext): string {
  const context = parseObject(ctx.context);
  // The host plugs prompt/input into ctx.context in a handful of shapes; try
  // the most common ones in order. Fall back to a JSON stringification of
  // the full context so the receiving agent at least sees the data.
  const candidates = [
    context.prompt,
    context.input,
    context.message,
    (context as { task?: { prompt?: unknown } }).task?.prompt,
    (context as { task?: { input?: unknown } }).task?.input,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  try {
    return JSON.stringify(ctx.context ?? {});
  } catch {
    return "";
  }
}

function extractContextId(ctx: AdapterExecutionContext): string | null {
  const context = parseObject(ctx.context);
  const candidates = [
    context.contextId,
    context.context_id,
    (context as { session?: { id?: unknown } }).session?.id,
    (context as { thread?: { id?: unknown } }).thread?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * adapter-a2a-mqtt's execute().
 *
 * Publishes an A2A Task request to the target agent's request topic and
 * awaits the reply on a freshly-generated reply topic (correlated via MQTT
 * v5 Correlation Data). Returns an AdapterExecutionResult shaped from the
 * Task object the remote agent returns.
 *
 * Connection lifecycle: opens a short-lived connection per execute() so the
 * adapter is safe to call from any context (server-side or worker). The
 * host singleton in server/src/mqtt/client.ts is what powers high-frequency
 * paths (event bridge + Agent Card projector).
 */
export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const target = resolveTarget(ctx);

  const requestTopic = target.poolRoleId
    ? buildPoolRequestTopic(target.companyId, target.circleId, target.poolRoleId)
    : buildRequestTopic(target.companyId, target.circleId, target.agentId);

  const taskId = randomUUID();
  const replyTopic = buildReplyTopic(
    target.companyId,
    target.circleId,
    target.agentId,
    taskId,
  );

  const prompt = extractPrompt(ctx);
  const contextId = extractContextId(ctx);
  const taskPayload: Record<string, unknown> = {
    id: taskId,
    kind: "task",
    role: "user",
    message: {
      role: "user",
      parts: [{ kind: "text", text: prompt }],
    },
    metadata: {
      runId: ctx.runId,
      agentId: ctx.agent.id,
    },
  };
  if (contextId) taskPayload.context_id = contextId;

  const clientId = `paperclip-adapter-${ctx.runId}-${randomUUID().slice(0, 8)}`;
  const clientConfig: A2AClientConfig = {
    brokerUrl: target.brokerUrl,
    clientId,
    username: target.username ?? undefined,
    password: target.password ?? undefined,
    cleanStart: true,
  };

  const startedAt = new Date();

  try {
    const client = await createA2AClient(clientConfig);
    try {
      const reply = await publishRequestAwaitReply(client, {
        requestTopic,
        replyTopic,
        payload: taskPayload,
        timeoutMs: target.timeoutMs,
        userProperties: {
          "a2a-task-id": taskId,
          "a2a-run-id": ctx.runId,
          "a2a-content": "task",
          ...(contextId ? { "a2a-context-id": contextId } : {}),
        },
        contentType: "application/json",
      });

      const replyObj =
        reply.payload && typeof reply.payload === "object" && !Array.isArray(reply.payload)
          ? (reply.payload as Record<string, unknown>)
          : { result: reply.payload };

      const status =
        typeof (replyObj as { status?: unknown }).status === "string"
          ? ((replyObj as { status?: string }).status ?? "").toLowerCase()
          : "";
      const errorMessage =
        typeof (replyObj as { errorMessage?: unknown }).errorMessage === "string"
          ? ((replyObj as { errorMessage?: string }).errorMessage ?? null)
          : null;
      const isFailure =
        status === "failed" ||
        status === "rejected" ||
        status === "canceled" ||
        Boolean(errorMessage);

      const summary =
        typeof (replyObj as { summary?: unknown }).summary === "string"
          ? ((replyObj as { summary?: string }).summary ?? null)
          : null;

      return {
        exitCode: isFailure ? 1 : 0,
        signal: null,
        timedOut: false,
        errorMessage: isFailure ? errorMessage ?? "A2A task did not complete successfully" : null,
        resultJson: replyObj,
        summary,
        sessionDisplayId: contextId,
        sessionParams: contextId ? { contextId } : null,
        provider: "a2a_mqtt",
      };
    } finally {
      try {
        await client.endAsync(false);
      } catch {
        // best-effort: connection may already be closed
      }
    }
  } catch (err) {
    const isTimeout =
      err instanceof Error && /timed out/i.test(err.message);
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown a2a-mqtt error");
    return {
      exitCode: isTimeout ? null : 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage: message,
      errorCode: isTimeout ? "a2a_mqtt_timeout" : "a2a_mqtt_failure",
      errorFamily: isTimeout ? "transient_upstream" : null,
      errorMeta: {
        requestTopic,
        replyTopic,
        startedAt: startedAt.toISOString(),
      },
      provider: "a2a_mqtt",
    };
  }
}
