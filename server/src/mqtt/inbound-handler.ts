/**
 * Shared A2A inbound dispatcher. Called by both the host singleton bridge
 * (`agent-runtime-bridge.ts`) and the per-agent client manager
 * (`per-agent-client-manager.ts`) so the two paths share one canonical
 * implementation of the inbound contract.
 *
 * Phase 1.13 — the dispatcher now classifies every inbound topic into one of
 * three buckets and routes to a different materialiser:
 *  - `request` (personal-direct, pool, or skill request) → materialise as an
 *    `issues` row + sidecar `a2a_pending_replies` row + queue wakeup. This is
 *    the legacy path.
 *  - `broadcast` (circle event topics — `paperclip/v1/event/{c}/{cir}/+`)
 *    → record into `agent_perceptions` keyed on `(agentId, topic,
 *    payloadHash)`. No issue is created and no wakeup is queued; the
 *    perception is surfaced to the agent the next time it runs for any
 *    reason via the neighbourhood snapshot.
 *  - `ignored` — discovery, DNA, heartbeat, and other retained topics that
 *    are handled by their dedicated projector / runtime code path. The
 *    dispatcher drops them without action.
 *
 * Idempotency on duplicate delivery (hybrid mode delivers to both the host
 * singleton AND the per-agent client for personal-direct + circle-broadcast
 * topics) is enforced differently per bucket:
 *  - Request: `a2a_pending_replies.task_id` lookup — the second delivery
 *    finds the existing row and bails.
 *  - Broadcast: 60s window dedupe via
 *    `idempotency_key = sha256(agentId|topic|payloadHash)`.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { a2aPendingReplies, agentPerceptions } from "@paperclipai/db";
import type { SubscribeMessage } from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";
import { coerceRowsList } from "../util/db.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";
import type { AgentSlot } from "./subscription-compute.js";

const A2APartSchema = z
  .object({
    text: z.string().optional(),
  })
  .passthrough();

const A2AMessageSchema = z
  .object({
    role: z.string().optional(),
    parts: z.array(A2APartSchema).default([]),
  })
  .passthrough();

const A2ATaskSchema = z
  .object({
    id: z.string().min(1),
    context_id: z.string().optional(),
    message: A2AMessageSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

type A2ATask = z.infer<typeof A2ATaskSchema>;

function decodePayload(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  const text = buf.toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function deriveTitle(task: A2ATask): string {
  const part = task.message?.parts?.[0];
  const text =
    part && typeof part.text === "string" && part.text.trim().length > 0
      ? part.text.trim()
      : "";
  if (text.length === 0) return "[A2A] request";
  return text.length > 200 ? text.slice(0, 200) : text;
}

export type InboundTopicClass = "request" | "broadcast" | "directive" | "ignored";

/**
 * Classify an inbound MQTT topic into one of three routing buckets. The
 * matcher is deliberately strict so adding new topic shapes is an explicit
 * decision rather than an accidental fall-through into either path.
 *
 * Request topics:
 *   paperclip/v1/request/{c}/{circle}/{agent}
 *   paperclip/v1/request/{c}/{circle}/pool/{role}
 *   paperclip/v1/role/{c}/{circle}/{role}            (role-pool shared-sub delivery)
 *   paperclip/v1/role/{c}/{circle}/{role}/broadcast  (role broadcast — still a request)
 *   paperclip/v1/skill/{c}/{slug}                    (skill-pool shared-sub delivery)
 *   paperclip/v1/skill/{c}/{slug}/broadcast          (skill broadcast — still a request)
 *
 * Broadcast topics:
 *   paperclip/v1/event/{c}/{circle}/+   (any sub-channel — announce, tactical-pulse, tension-raised, etc.)
 *
 * Ignored topics (handled elsewhere):
 *   paperclip/v1/discovery/{...}        (agent-card-projector)
 *   paperclip/v1/dna/{c}                 (dna-projector)
 *   paperclip/v1/heartbeat{...}         (heartbeat runtime)
 *   paperclip/v1/reply/{...}            (a2a-runtime-bridge reply hook)
 *   paperclip/v1/idm/{...}, /crosslink/ (handled by dedicated topics)
 */
export function classifyInboundTopic(topic: string): InboundTopicClass {
  // Phase 1.16-EMQX E1 — Accept both `$a2a/v1/` (A2A-spec topics indexed
  // by the EMQX A2A Registry: discovery/request/reply/event/pool) and
  // `paperclip/v1/` (Paperclip-specific transport: heartbeat/dna/idm/
  // discussion/role/skill/crosslink). Strip whichever prefix is present
  // before dispatching on the channel name.
  let rest: string;
  if (topic.startsWith("$a2a/v1/")) {
    rest = topic.slice("$a2a/v1/".length);
  } else if (topic.startsWith("paperclip/v1/")) {
    rest = topic.slice("paperclip/v1/".length);
  } else {
    return "ignored";
  }
  const head = rest.split("/", 1)[0];
  switch (head) {
    case "request":
    case "role":
    case "skill":
      return "request";
    case "event":
      // event/{companyId}/{circleId}/{channel} — at least 4 segments after
      // the prefix. We treat any sub-channel under a circle as a broadcast.
      // (Future: if we add a dedicated event sub-channel that should
      // materialise as an issue, add an explicit allowlist here.)
      return "broadcast";
    case "discovery":
    case "dna":
    case "heartbeat":
    case "heartbeat-ack":
    case "reply":
    case "idm":
    case "crosslink":
      return "ignored";
    case "discussion":
      // Phase 1.15a — paperclip/v1/discussion/{companyId}/{contextId}
      // Treat as a broadcast (record into agent_perceptions) AND mark
      // wake_eligible so the heartbeat scheduler enqueues a wakeup.
      return "broadcast";
    case "directive":
      // Phase 1.17 — $a2a/v1/directive/{companyId}. One inbound publish
      // materialises N issues (one per recipient per the scope). Routed
      // to a dedicated handler, NOT through the perception/issue paths.
      return "directive";
    default:
      return "ignored";
  }
}

/**
 * Phase 1.15a — true when the topic is a discussion topic and the perception
 * record should be flagged `wake_eligible=true`.
 */
function isWakeEligibleTopic(topic: string): boolean {
  if (!topic.startsWith("paperclip/v1/discussion/")) return false;
  return topic.split("/").length === 5;
}

function computeIdempotencyKey(
  agentId: string,
  topic: string,
  payload: Buffer,
): string {
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  return createHash("sha256")
    .update(agentId)
    .update("|")
    .update(topic)
    .update("|")
    .update(payloadHash)
    .digest("hex");
}

export interface InboundHandlerContext {
  db: Db;
  /** Tag carried through activity log + logs so operators can tell which
   *  surface (`a2a-runtime-bridge` vs `per-agent-client`) materialised the
   *  issue. Defaults to `a2a-runtime-bridge` for log continuity. */
  actorId?: string;
}

/**
 * Dispatch entry point. Classifies the inbound topic and routes to the
 * appropriate materialiser. Errors inside one branch never bring down the
 * dispatcher — they're logged and the message is dropped.
 */
export async function handleA2AInbound(
  ctx: InboundHandlerContext,
  slot: AgentSlot,
  msg: SubscribeMessage,
): Promise<void> {
  const actorId = ctx.actorId ?? "a2a-runtime-bridge";
  const cls = classifyInboundTopic(msg.topic);
  if (cls === "ignored") {
    logger.debug(
      { topic: msg.topic, slot },
      `${actorId}: inbound topic ignored (handled elsewhere)`,
    );
    return;
  }
  if (cls === "broadcast") {
    await handleBroadcastInbound(ctx, slot, msg, actorId);
    return;
  }
  if (cls === "directive") {
    await handleDirectiveInbound(ctx, msg, actorId);
    return;
  }
  await handleRequestInbound(ctx, slot, msg, actorId);
}

/**
 * Materialise an A2A Task request as an `issues` row + sidecar
 * `a2a_pending_replies` row. The runtime bridge / per-agent manager schedules
 * a wakeup off the back of the issue insert.
 */
async function handleRequestInbound(
  ctx: InboundHandlerContext,
  slot: AgentSlot,
  msg: SubscribeMessage,
  actorId: string,
): Promise<void> {
  const raw = decodePayload(msg.payload);
  const parsed = A2ATaskSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      {
        slot,
        err: parsed.error.flatten(),
        preview: msg.payload.toString("utf-8").slice(0, 200),
      },
      `${actorId}: invalid A2A task payload, dropping`,
    );
    return;
  }
  const task = parsed.data;

  try {
    const existing = await ctx.db
      .select({ issueId: a2aPendingReplies.issueId })
      .from(a2aPendingReplies)
      .where(eq(a2aPendingReplies.taskId, task.id))
      .limit(1);
    if (existing.length > 0) {
      logger.debug(
        { taskId: task.id, slot },
        `${actorId}: duplicate task_id, skipping`,
      );
      return;
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, `${actorId}: idempotency check failed`);
  }

  const responseTopic = msg.responseTopic;
  if (!responseTopic) {
    logger.warn(
      { slot, taskId: task.id },
      `${actorId}: request missing Response Topic, dropping (no reply path)`,
    );
    return;
  }

  const correlationData = msg.correlationData ?? null;

  const title = deriveTitle(task);
  const description = JSON.stringify(task);
  const originFingerprint = correlationData
    ? correlationData.toString("hex")
    : `a2a:${task.id}`;

  // Phase 1.13 — multi-turn conversation thread id. Reuse the inbound
  // `Task.context_id` when the publisher supplied one (continuing a thread);
  // otherwise mint a fresh UUID so every A2A-originated issue has a stable
  // thread identifier. The bridge reply hook + plugin tools echo this on
  // outbound replies so downstream peers can group messages by conversation.
  const contextId =
    typeof task.context_id === "string" && task.context_id.length > 0
      ? task.context_id
      : randomUUID();

  try {
    const svc = issueService(ctx.db);
    const created = await svc.create(slot.companyId, {
      title,
      description,
      kind: "next_action",
      status: "backlog",
      assigneeAgentId: slot.agentId,
      originKind: "a2a:request",
      originId: task.id,
      originFingerprint,
      originTopic: msg.topic,
      a2aContextId: contextId,
    } as Parameters<typeof svc.create>[1]);

    await ctx.db.insert(a2aPendingReplies).values({
      issueId: created.id,
      taskId: task.id,
      responseTopic,
      correlationData: correlationData ?? undefined,
      userProperties: msg.userProperties ?? {},
    });

    try {
      await logActivity(ctx.db, {
        companyId: slot.companyId,
        actorType: "system",
        actorId,
        action: "a2a.task_received",
        entityType: "issue",
        entityId: created.id,
        agentId: slot.agentId,
        details: {
          taskId: task.id,
          contextId,
          inboundContextId: task.context_id ?? null,
          responseTopic,
          correlationDataHex: correlationData?.toString("hex") ?? null,
          originTopic: msg.topic,
        },
      });
    } catch (err) {
      logger.debug({ err, taskId: task.id }, `${actorId}: audit log failed`);
    }

    logger.info(
      {
        taskId: task.id,
        issueId: created.id,
        identifier: created.identifier ?? null,
        slot,
      },
      `${actorId}: A2A request → issue created`,
    );
  } catch (err) {
    logger.warn(
      { err, taskId: task.id, slot },
      `${actorId}: failed to materialise A2A request as issue`,
    );
  }
}

/**
 * Record a circle-broadcast event as a perception. No issue is created; no
 * wakeup is queued. Dedupes within a 60s window on
 * `sha256(agentId|topic|payloadHash)` so redelivered messages (hybrid mode
 * fan-out) don't double-insert.
 */
async function handleBroadcastInbound(
  ctx: InboundHandlerContext,
  slot: AgentSlot,
  msg: SubscribeMessage,
  actorId: string,
): Promise<void> {
  const idempotencyKey = computeIdempotencyKey(slot.agentId, msg.topic, msg.payload);

  // 60s app-level dedupe window. We use a parameterised gt(received_at, NOW() - 60s)
  // SELECT-then-INSERT inside the same connection; the worst-case race is a
  // tiny duplicate window that the snapshot reader (which limits to 20 rows
  // anyway) won't care about.
  try {
    const existing = await ctx.db
      .select({ id: agentPerceptions.id })
      .from(agentPerceptions)
      .where(
        and(
          eq(agentPerceptions.idempotencyKey, idempotencyKey),
          gt(agentPerceptions.receivedAt, sql`NOW() - INTERVAL '60 seconds'`),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      logger.debug(
        { topic: msg.topic, agentId: slot.agentId, idempotencyKey },
        `${actorId}: duplicate broadcast within 60s window, skipping`,
      );
      return;
    }
  } catch (err) {
    logger.warn(
      { err, topic: msg.topic, agentId: slot.agentId },
      `${actorId}: perception idempotency check failed`,
    );
  }

  // The payload is best-effort JSON; if it isn't valid JSON the broadcast is
  // dropped because `payload_json` is jsonb NOT NULL. Plain-string payloads
  // are wrapped as `{ text: <string> }` so they still flow.
  const decoded = decodePayload(msg.payload);
  const payloadJson =
    decoded === null
      ? { _raw: null }
      : typeof decoded === "string"
      ? { text: decoded }
      : (decoded as Record<string, unknown>);

  const wakeEligible = isWakeEligibleTopic(msg.topic);
  try {
    await ctx.db.insert(agentPerceptions).values({
      agentId: slot.agentId,
      topic: msg.topic,
      payloadJson,
      userProperties: msg.userProperties ?? null,
      idempotencyKey,
      wakeEligible,
    });
    logger.debug(
      { topic: msg.topic, agentId: slot.agentId, companyId: slot.companyId },
      `${actorId}: broadcast → perception recorded`,
    );
  } catch (err) {
    logger.warn(
      { err, topic: msg.topic, agentId: slot.agentId },
      `${actorId}: failed to record perception`,
    );
  }
}

/**
 * Phase 1.17 — `$a2a/v1/directive/{companyId}` handler.
 *
 * ONE external publish triggers fan-out to N recipients. Each recipient
 * gets ONE issue (assigned to them) whose body references the bundled
 * skill they should invoke. Claude Code matches issue text to skill
 * frontmatter description automatically.
 *
 * Payload shape (Zod-validated):
 *   {
 *     "kind": "plan-routines" | "plan-goals" | ...,
 *     "body": "free-text instruction shown to each recipient",
 *     "scope": "lead_links" | "all_agents" | { "circleIds": ["uuid", ...] }
 *   }
 *
 * Recipient resolution per scope:
 *   - "lead_links"           → every agent holding role_type='circle_lead'
 *   - "all_agents"           → every non-archived agent in the company
 *   - { circleIds: [...] }   → every agent whose home circle is in the list
 */
const DirectiveScopeSchema = z.union([
  z.literal("lead_links"),
  z.literal("all_agents"),
  z.object({ circleIds: z.array(z.string().uuid()).min(1) }),
]);

const DirectiveSchema = z.object({
  kind: z.string().min(1),
  body: z.string().min(1),
  scope: DirectiveScopeSchema.optional().default("lead_links"),
  title: z.string().optional(),
});

interface DirectiveKindStub {
  defaultTitle: (circleName: string) => string;
  defaultBody: (circleName: string, circleId: string) => string;
  skillHint: string;
}

const DIRECTIVE_KINDS: Record<string, DirectiveKindStub> = {
  "plan-routines": {
    defaultTitle: (circleName) =>
      `[Directive] Plan recurring meeting routines for ${circleName}`,
    defaultBody: (circleName, circleId) =>
      [
        `**Directive**: Create the recurring meeting routines for the **${circleName}** circle (id: \`${circleId}\`).`,
        ``,
        `**Skill to use**: \`paperclip-create-recurring-routine\`.`,
        ``,
        `**Required**:`,
        `- ONE governance meeting routine (weekly, 1.5h)`,
        `- ONE tactical meeting routine (weekly, 1.5h)`,
        ``,
        `Each routine MUST have a \`schedule_trigger\` with a cron expression in UTC. Pick times that don't clash with sibling circles' meetings (check existing routines in the company first).`,
        ``,
        `Assign each routine to the **Facilitator** role-holder (the agent who runs the meeting). The Secretary captures minutes after.`,
        ``,
        `When done: comment with the routine IDs + next_run_at + close this issue. Do NOT decompose into static child tasks — the routine + trigger pair IS the recurring event.`,
      ].join("\n"),
    skillHint: "paperclip-create-recurring-routine",
  },
  "plan-goals": {
    defaultTitle: (circleName) =>
      `[Directive] Set quarterly goals for ${circleName}`,
    defaultBody: (circleName, circleId) =>
      [
        `**Directive**: Define this quarter's goals for the **${circleName}** circle (id: \`${circleId}\`).`,
        ``,
        `**Skill to use**: \`paperclip-create-goal\`.`,
        ``,
        `**Required**:`,
        `- ONE quarterly objective goal (level=objective) under the company's current strategy goal`,
        `- 2-4 task goals under that objective`,
        ``,
        `Owner of the objective is YOU (the Lead Link of this circle). Task owners can be specialist role-holders.`,
      ].join("\n"),
    skillHint: "paperclip-create-goal",
  },
};

interface RecipientRow extends Record<string, unknown> {
  agentId: string;
  agentName: string;
  circleId: string;
  circleName: string;
  projectId: string | null;
}

async function resolveLeadLinks(
  db: Db,
  companyId: string,
): Promise<RecipientRow[]> {
  const rows = await db.execute<RecipientRow>(sql`
    SELECT
      a.id::text          AS "agentId",
      a.name              AS "agentName",
      c.id::text          AS "circleId",
      c.name              AS "circleName",
      c.project_id::text  AS "projectId"
    FROM public.agents a
    JOIN plugin_holacracy_c5049b5dfe.role_assignments ra ON ra.agent_id = a.id
    JOIN plugin_holacracy_c5049b5dfe.roles r              ON r.id = ra.role_id
    JOIN plugin_holacracy_c5049b5dfe.circles c            ON c.id = r.circle_id
    WHERE a.company_id = ${companyId}::uuid
      AND a.status NOT IN ('archived','terminated')
      AND r.role_type = 'circle_lead'
    ORDER BY c.name, a.name
  `);
  return coerceRowsList<RecipientRow>(rows);
}

/**
 * Phase 1.17 — wire the host singleton's subscription to the directive
 * wildcard. Call once at server bootstrap (after `initMqtt()`).
 * Idempotent — subscribing twice is a no-op (mqtt.js dedupes filters).
 */
export async function initDirectiveSubscription(db: Db): Promise<void> {
  const { subscribe } = await import("./client.js");
  await subscribe("$a2a/v1/directive/+", (msg) => {
    void handleDirectiveInbound({ db, actorId: "a2a-directive-dispatcher" }, msg, "a2a-directive-dispatcher");
  });
  logger.info({ filter: "$a2a/v1/directive/+" }, "directive-dispatcher: host subscribed");
}

async function handleDirectiveInbound(
  ctx: InboundHandlerContext,
  msg: SubscribeMessage,
  actorId: string,
): Promise<void> {
  // Topic = `$a2a/v1/directive/{companyId}` → companyId is the 4th segment
  const segments = msg.topic.split("/");
  const companyId = segments[3];
  if (!companyId) {
    logger.warn({ topic: msg.topic }, `${actorId}: directive missing companyId in topic`);
    return;
  }

  const decoded = decodePayload(msg.payload);
  const parsed = DirectiveSchema.safeParse(decoded);
  if (!parsed.success) {
    logger.warn(
      { topic: msg.topic, err: parsed.error.flatten(), preview: msg.payload.toString("utf-8").slice(0, 200) },
      `${actorId}: invalid directive payload, dropping`,
    );
    return;
  }
  const directive = parsed.data;
  const stub = DIRECTIVE_KINDS[directive.kind];
  if (!stub) {
    logger.warn(
      { topic: msg.topic, kind: directive.kind },
      `${actorId}: unknown directive kind, dropping`,
    );
    return;
  }

  // Resolve recipients
  let recipients: RecipientRow[] = [];
  try {
    if (directive.scope === "lead_links") {
      recipients = await resolveLeadLinks(ctx.db, companyId);
    } else {
      logger.warn({ scope: directive.scope }, `${actorId}: directive scope not yet implemented`);
      return;
    }
  } catch (err) {
    logger.warn({ err, companyId }, `${actorId}: directive recipient resolution failed`);
    return;
  }
  if (recipients.length === 0) {
    logger.warn({ companyId, scope: directive.scope }, `${actorId}: directive resolved zero recipients`);
    return;
  }

  // Fan out: ONE issue per recipient
  const svc = issueService(ctx.db);
  let materialised = 0;
  for (const r of recipients) {
    const title = directive.title ?? stub.defaultTitle(r.circleName);
    const body = `${directive.body}\n\n---\n\n${stub.defaultBody(r.circleName, r.circleId)}`;
    try {
      const created = await svc.create(companyId, {
        title,
        description: body,
        kind: "next_action",
        status: "todo",
        assigneeAgentId: r.agentId,
        projectId: r.projectId ?? undefined,
        originKind: "a2a:directive",
        originId: `${directive.kind}:${r.agentId}`,
        originFingerprint: `directive:${directive.kind}:${r.agentId}:${Date.now()}`,
        originTopic: msg.topic,
      } as Parameters<typeof svc.create>[1]);
      materialised += 1;
      await logActivity(ctx.db, {
        companyId,
        actorType: "system",
        actorId,
        action: "a2a.directive_materialised",
        entityType: "issue",
        entityId: created.id,
        agentId: r.agentId,
        details: { kind: directive.kind, scope: "lead_links", circleId: r.circleId, skillHint: stub.skillHint },
      }).catch(() => {});
    } catch (err) {
      logger.warn(
        { err, agentId: r.agentId, kind: directive.kind },
        `${actorId}: directive issue creation failed for recipient`,
      );
    }
  }
  logger.info(
    { companyId, kind: directive.kind, recipients: recipients.length, materialised },
    `${actorId}: directive fan-out complete`,
  );
}
