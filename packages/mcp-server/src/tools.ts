import { z } from "zod";
import {
  addIssueCommentSchema,
  askUserQuestionsPayloadSchema,
  checkoutIssueSchema,
  createApprovalSchema,
  createIssueSchema,
  issueThreadInteractionContinuationPolicySchema,
  requestConfirmationPayloadSchema,
  suggestTasksPayloadSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

function parseOptionalJson(raw: string | undefined | null): unknown {
  if (!raw || raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

const companyIdOptional = z.string().uuid().optional().nullable();
const agentIdOptional = z.string().uuid().optional().nullable();
const issueIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const goalIdSchema = z.string().uuid();
const approvalIdSchema = z.string().uuid();
const documentKeySchema = z.string().trim().min(1).max(64);

const listIssuesSchema = z.object({
  companyId: companyIdOptional,
  status: z.string().optional(),
  projectId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  participantAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().optional(),
  touchedByUserId: z.string().optional(),
  inboxArchivedByUserId: z.string().optional(),
  unreadForUserId: z.string().optional(),
  labelId: z.string().uuid().optional(),
  executionWorkspaceId: z.string().uuid().optional(),
  originKind: z.string().optional(),
  originId: z.string().optional(),
  includeRoutineExecutions: z.boolean().optional(),
  q: z.string().optional(),
});

const listCommentsSchema = z.object({
  issueId: issueIdSchema,
  after: z.string().uuid().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const upsertDocumentToolSchema = z.object({
  issueId: issueIdSchema,
  key: documentKeySchema,
  title: z.string().trim().max(200).nullable().optional(),
  format: z.enum(["markdown"]).default("markdown"),
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

const createIssueToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createIssueSchema);

const updateIssueToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(updateIssueSchema);

const checkoutIssueToolSchema = z.object({
  issueId: issueIdSchema,
  agentId: agentIdOptional,
  expectedStatuses: checkoutIssueSchema.shape.expectedStatuses.optional(),
});

const addCommentToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(addIssueCommentSchema);

const createSuggestTasksToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: suggestTasksPayloadSchema,
});

const createAskUserQuestionsToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: askUserQuestionsPayloadSchema,
});

const createRequestConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
  payload: requestConfirmationPayloadSchema,
});

const approvalDecisionSchema = z.object({
  approvalId: approvalIdSchema,
  action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
  decisionNote: z.string().optional(),
  payloadJson: z.string().optional(),
});

const createApprovalToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createApprovalSchema);

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  jsonBody: z.string().optional(),
});

const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
});

const issueWorkspaceRuntimeControlSchema = z.object({
  issueId: issueIdSchema,
  action: z.enum(["start", "stop", "restart"]),
}).merge(workspaceRuntimeControlTargetSchema);

const waitForIssueWorkspaceServiceSchema = z.object({
  issueId: issueIdSchema,
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceName: z.string().min(1).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(300).optional(),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCurrentExecutionWorkspace(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const workspace = (context as { currentExecutionWorkspace?: unknown }).currentExecutionWorkspace;
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : null;
}

function readWorkspaceRuntimeServices(workspace: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = workspace?.runtimeServices;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function selectRuntimeService(
  services: Array<Record<string, unknown>>,
  input: { runtimeServiceId?: string | null; serviceName?: string | null },
) {
  if (input.runtimeServiceId) {
    return services.find((service) => service.id === input.runtimeServiceId) ?? null;
  }
  if (input.serviceName) {
    return services.find((service) => service.serviceName === input.serviceName) ?? null;
  }
  return services.find((service) => service.status === "running" || service.status === "starting")
    ?? services[0]
    ?? null;
}

async function getIssueWorkspaceRuntime(client: PaperclipApiClient, issueId: string) {
  const context = await client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const workspace = readCurrentExecutionWorkspace(context);
  return {
    context,
    workspace,
    runtimeServices: readWorkspaceRuntimeServices(workspace),
  };
}

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "paperclipMe",
      "Get the current authenticated Paperclip actor details",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me"),
    ),
    makeTool(
      "paperclipInboxLite",
      "Get the current authenticated agent inbox-lite assignment list",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me/inbox-lite"),
    ),
    makeTool(
      "paperclipListAgents",
      "List agents in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/agents`),
    ),
    makeTool(
      "paperclipGetAgent",
      "Get a single agent by id",
      z.object({ agentId: z.string().min(1), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}${qs}`);
      },
    ),
    makeTool(
      "paperclipListIssues",
      "List issues for a company with optional filters",
      listIssuesSchema,
      async (input) => {
        const companyId = client.resolveCompanyId(input.companyId);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (key === "companyId" || value === undefined || value === null) continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        return client.requestJson("GET", `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipGetIssue",
      "Get a single issue by UUID or identifier",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`),
    ),
    makeTool(
      "paperclipGetHeartbeatContext",
      "Get compact heartbeat context for an issue",
      z.object({ issueId: issueIdSchema, wakeCommentId: z.string().uuid().optional() }),
      async ({ issueId, wakeCommentId }) => {
        const qs = wakeCommentId ? `?wakeCommentId=${encodeURIComponent(wakeCommentId)}` : "";
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context${qs}`);
      },
    ),
    makeTool(
      "paperclipListComments",
      "List issue comments with incremental options",
      listCommentsSchema,
      async ({ issueId, after, order, limit }) => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (order) params.set("order", order);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipGetComment",
      "Get a specific issue comment by id",
      z.object({ issueId: issueIdSchema, commentId: z.string().uuid() }),
      async ({ issueId, commentId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`),
    ),
    makeTool(
      "paperclipListIssueApprovals",
      "List approvals linked to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/approvals`),
    ),
    makeTool(
      "paperclipListDocuments",
      "List issue documents",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents`),
    ),
    makeTool(
      "paperclipGetDocument",
      "Get one issue document by key",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`),
    ),
    makeTool(
      "paperclipListDocumentRevisions",
      "List revisions for an issue document",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson(
          "GET",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
        ),
    ),
    makeTool(
      "paperclipListProjects",
      "List projects in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/projects`),
    ),
    makeTool(
      "paperclipGetProject",
      "Get a project by id or company-scoped short reference",
      z.object({ projectId: projectIdSchema, companyId: companyIdOptional }),
      async ({ projectId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/projects/${encodeURIComponent(projectId)}${qs}`);
      },
    ),
    makeTool(
      "paperclipGetIssueWorkspaceRuntime",
      "Get the current execution workspace and runtime services for an issue, including service URLs",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => getIssueWorkspaceRuntime(client, issueId),
    ),
    makeTool(
      "paperclipControlIssueWorkspaceServices",
      "Start, stop, or restart the current issue execution workspace runtime services",
      issueWorkspaceRuntimeControlSchema,
      async ({ issueId, action, ...target }) => {
        const runtime = await getIssueWorkspaceRuntime(client, issueId);
        const workspaceId = typeof runtime.workspace?.id === "string" ? runtime.workspace.id : null;
        if (!workspaceId) {
          throw new Error("Issue has no current execution workspace");
        }
        return client.requestJson(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
          { body: target },
        );
      },
    ),
    makeTool(
      "paperclipWaitForIssueWorkspaceService",
      "Wait until an issue execution workspace runtime service is running and has a URL when one is exposed",
      waitForIssueWorkspaceServiceSchema,
      async ({ issueId, runtimeServiceId, serviceName, timeoutSeconds }) => {
        const deadline = Date.now() + (timeoutSeconds ?? 60) * 1000;
        let latest: Awaited<ReturnType<typeof getIssueWorkspaceRuntime>> | null = null;
        while (Date.now() <= deadline) {
          latest = await getIssueWorkspaceRuntime(client, issueId);
          const service = selectRuntimeService(latest.runtimeServices, { runtimeServiceId, serviceName });
          if (service?.status === "running" && service.healthStatus !== "unhealthy") {
            return {
              workspace: latest.workspace,
              service,
            };
          }
          await sleep(1000);
        }

        return {
          timedOut: true,
          latestWorkspace: latest?.workspace ?? null,
          latestRuntimeServices: latest?.runtimeServices ?? [],
        };
      },
    ),
    makeTool(
      "paperclipListGoals",
      "List goals in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/goals`),
    ),
    makeTool(
      "paperclipGetGoal",
      "Get a goal by id",
      z.object({ goalId: goalIdSchema }),
      async ({ goalId }) => client.requestJson("GET", `/goals/${encodeURIComponent(goalId)}`),
    ),
    makeTool(
      "paperclipListApprovals",
      "List approvals in a company",
      z.object({ companyId: companyIdOptional, status: z.string().optional() }),
      async ({ companyId, status }) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/approvals${qs}`);
      },
    ),
    makeTool(
      "paperclipCreateApproval",
      "Create a board approval request, optionally linked to one or more issues",
      createApprovalToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/approvals`, {
          body,
        }),
    ),
    makeTool(
      "paperclipGetApproval",
      "Get an approval by id",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}`),
    ),
    makeTool(
      "paperclipGetApprovalIssues",
      "List issues linked to an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/issues`),
    ),
    makeTool(
      "paperclipListApprovalComments",
      "List comments for an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/comments`),
    ),
    makeTool(
      "paperclipCreateIssue",
      "Create a new issue",
      createIssueToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, { body }),
    ),
    makeTool(
      "paperclipUpdateIssue",
      "Patch an issue, optionally including a comment; include resume=true when intentionally requesting follow-up on resumable closed work",
      updateIssueToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, { body }),
    ),
    makeTool(
      "paperclipCheckoutIssue",
      "Checkout an issue for an agent",
      checkoutIssueToolSchema,
      async ({ issueId, agentId, expectedStatuses }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
          body: {
            agentId: client.resolveAgentId(agentId),
            expectedStatuses: expectedStatuses ?? ["todo", "backlog", "blocked"],
          },
        }),
    ),
    makeTool(
      "paperclipReleaseIssue",
      "Release an issue checkout",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/release`, { body: {} }),
    ),
    makeTool(
      "paperclipAddComment",
      "Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work",
      addCommentToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    ),
    makeTool(
      "paperclipSuggestTasks",
      "Create a suggest_tasks interaction on an issue",
      createSuggestTasksToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "suggest_tasks",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipAskUserQuestions",
      "Create an ask_user_questions interaction on an issue",
      createAskUserQuestionsToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "ask_user_questions",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestConfirmation",
      "Create a request_confirmation interaction on an issue",
      createRequestConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipUpsertIssueDocument",
      "Create or update an issue document",
      upsertDocumentToolSchema,
      async ({ issueId, key, ...body }) =>
        client.requestJson(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          { body },
        ),
    ),
    makeTool(
      "paperclipRestoreIssueDocumentRevision",
      "Restore a prior revision of an issue document",
      z.object({
        issueId: issueIdSchema,
        key: documentKeySchema,
        revisionId: z.string().uuid(),
      }),
      async ({ issueId, key, revisionId }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          { body: {} },
        ),
    ),
    makeTool(
      "paperclipLinkIssueApproval",
      "Link an approval to an issue",
      z.object({ issueId: issueIdSchema }).merge(linkIssueApprovalSchema),
      async ({ issueId, approvalId }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/approvals`, {
          body: { approvalId },
        }),
    ),
    makeTool(
      "paperclipUnlinkIssueApproval",
      "Unlink an approval from an issue",
      z.object({ issueId: issueIdSchema, approvalId: approvalIdSchema }),
      async ({ issueId, approvalId }) =>
        client.requestJson(
          "DELETE",
          `/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
        ),
    ),
    makeTool(
      "paperclipApprovalDecision",
      "Approve, reject, request revision, or resubmit an approval",
      approvalDecisionSchema,
      async ({ approvalId, action, decisionNote, payloadJson }) => {
        const path =
          action === "approve"
            ? `/approvals/${encodeURIComponent(approvalId)}/approve`
            : action === "reject"
              ? `/approvals/${encodeURIComponent(approvalId)}/reject`
              : action === "requestRevision"
                ? `/approvals/${encodeURIComponent(approvalId)}/request-revision`
                : `/approvals/${encodeURIComponent(approvalId)}/resubmit`;

        const body =
          action === "resubmit"
            ? { payload: parseOptionalJson(payloadJson) ?? {} }
            : { decisionNote };

        return client.requestJson("POST", path, { body });
      },
    ),
    makeTool(
      "paperclipAddApprovalComment",
      "Add a comment to an approval",
      z.object({ approvalId: approvalIdSchema, body: z.string().min(1) }),
      async ({ approvalId, body }) =>
        client.requestJson("POST", `/approvals/${encodeURIComponent(approvalId)}/comments`, {
          body: { body },
        }),
    ),
    makeTool(
      "paperclipApiRequest",
      "Make a JSON request to an existing Paperclip /api endpoint for unsupported operations",
      apiRequestSchema,
      async ({ method, path, jsonBody }) => {
        if (!path.startsWith("/") || path.includes("..")) {
          throw new Error("path must start with / and be relative to /api, and must not contain '..'");
        }
        return client.requestJson(method, path, {
          body: parseOptionalJson(jsonBody),
        });
      },
    ),

    // ── Holacracy plugin tools ────────────────────────────────────────────────

    makeTool(
      "holacracyListCircles",
      "List all Holacracy circles in the company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyGetCircle",
      "Get details of a single Holacracy circle including its roles and accountabilities",
      z.object({ circleId: z.string().min(1), companyId: companyIdOptional }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyCreateCircle",
      "Create a new Holacracy sub-circle. parentCircleId is required for all circles except the General Company Circle.",
      z.object({
        companyId: companyIdOptional,
        name: z.string().min(1),
        purpose: z.string().min(1),
        parentCircleId: z.string().optional().nullable(),
      }),
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/plugins/paperclipai.plugin-holacracy/api/circles`, {
          body: { companyId: client.resolveCompanyId(companyId), ...body },
        }),
    ),

    makeTool(
      "holacracyUpdateCircle",
      "Update the name, purpose, or domain of a Holacracy circle",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        name: z.string().optional(),
        purpose: z.string().optional(),
        domain: z.string().optional().nullable(),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "PATCH",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyDeleteCircle",
      "Delete a Holacracy circle (cannot delete the General Company Circle)",
      z.object({ circleId: z.string().min(1), companyId: companyIdOptional }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "DELETE",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyListRoles",
      "List roles assigned within a Holacracy circle (includes Circle Lead, Rep, Facilitator, Secretary, and custom roles)",
      z.object({ circleId: z.string().min(1), companyId: companyIdOptional }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/roles?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyAssignRole",
      "Assign an agent to a role in a circle. roleType: circle_lead | facilitator | secretary | circle_rep | custom. For custom also provide roleName + purpose. focusPercentage (0-100) = energy allocation.",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        agentId: z.string().uuid(),
        roleType: z.enum(["circle_lead", "facilitator", "secretary", "circle_rep", "custom"]),
        roleName: z.string().optional(),
        purpose: z.string().optional(),
        domain: z.string().optional().nullable(),
        accountabilities: z.array(z.string()).optional(),
        focusPercentage: z.number().int().min(0).max(100).optional(),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/roles`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyUpdateRoleAssignment",
      "Update an existing role assignment (focusPercentage, accountabilities, domain, or reassign to different agent)",
      z.object({
        circleId: z.string().min(1),
        roleId: z.string().min(1),
        companyId: companyIdOptional,
        agentId: z.string().uuid().optional(),
        roleName: z.string().optional(),
        purpose: z.string().optional(),
        domain: z.string().optional().nullable(),
        accountabilities: z.array(z.string()).optional(),
        focusPercentage: z.number().int().min(0).max(100).optional(),
      }),
      async ({ circleId, roleId, companyId, ...body }) =>
        client.requestJson(
          "PATCH",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/roles/${encodeURIComponent(roleId)}/assign`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyUpdateRole",
      "Update the definition of a role (name, purpose, domain, accountabilities) — governance change",
      z.object({
        circleId: z.string().min(1),
        roleId: z.string().min(1),
        companyId: companyIdOptional,
        roleName: z.string().optional(),
        purpose: z.string().optional(),
        domain: z.string().optional().nullable(),
        accountabilities: z.array(z.string()).optional(),
      }),
      async ({ circleId, roleId, companyId, ...body }) =>
        client.requestJson(
          "PATCH",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/roles/${encodeURIComponent(roleId)}`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyListTensions",
      "List open tensions in a circle, optionally filtered by type (operational | governance | all)",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        type: z.enum(["operational", "governance", "all"]).optional(),
      }),
      async ({ circleId, companyId, type }) => {
        const params = new URLSearchParams({ companyId: client.resolveCompanyId(companyId) });
        if (type) params.set("type", type);
        return client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/tensions?${params}`,
        );
      },
    ),

    makeTool(
      "holacracyRaiseTension",
      "Raise a tension in a circle for processing in the next Governance or Tactical meeting",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        title: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(["operational", "governance"]),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/tensions`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyUpdateTension",
      "Update or resolve a tension (mark as resolved, update description)",
      z.object({
        tensionId: z.string().min(1),
        companyId: companyIdOptional,
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["open", "resolved"]).optional(),
      }),
      async ({ tensionId, companyId, ...body }) =>
        client.requestJson(
          "PATCH",
          `/plugins/paperclipai.plugin-holacracy/api/tensions/${encodeURIComponent(tensionId)}`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyForwardTension",
      "Forward a tension from a sub-circle to the parent circle (Circle Rep role only)",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        tensionId: z.string().min(1),
        context: z.string().min(1),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/forward-tension`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyRecordDecision",
      "Record a governance decision in a circle (e.g. from a Governance Meeting outcome)",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        decision: z.string().min(1),
        rationale: z.string().optional(),
        relatedTensionId: z.string().optional().nullable(),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/decide`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyListPolicies",
      "List governance policies in a circle",
      z.object({ circleId: z.string().min(1), companyId: companyIdOptional }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/policies?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyCreatePolicy",
      "Create a governance policy in a circle (a rule governing role behavior or domain access)",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        title: z.string().min(1),
        description: z.string().min(1),
        appliesToRole: z.string().optional().nullable(),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/policies`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyListStrategies",
      "List strategies defined for a circle",
      z.object({ circleId: z.string().min(1), companyId: companyIdOptional }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/strategies?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyCreateStrategy",
      "Create a strategy heuristic for a circle — a rule-of-thumb guiding role prioritization (not a goal)",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        title: z.string().min(1),
        description: z.string().min(1),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/strategies`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    makeTool(
      "holacracyGetAuditLog",
      "Get the governance audit log for a circle (decisions, role changes, policy changes)",
      z.object({ circleId: z.string().min(1), companyId: companyIdOptional }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/audit-log?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyOnboardAgent",
      "Onboard an agent into a circle, creating an initial role assignment and briefing",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
        agentId: z.string().uuid(),
        roleType: z.enum(["circle_lead", "facilitator", "secretary", "circle_rep", "custom"]),
        roleName: z.string().optional(),
      }),
      async ({ circleId, companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/onboard-agent`,
          { body: { companyId: client.resolveCompanyId(companyId), ...body } },
        ),
    ),

    // T7-lift — high-value tools previously reachable only via the plugin API
    // routes (not MCP). Now bedrock_gateway agents can call them directly.
    makeTool(
      "holacracyGetRole",
      "Get a Holacracy role's details: purpose, accountabilities, domains, and the agent(s) filling it. Counterpart to holacracyGetCircle for individual-role inspection.",
      z.object({
        roleId: z.string().min(1),
        circleId: z.string().min(1),
        companyId: companyIdOptional,
      }),
      async ({ circleId, roleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/roles/${encodeURIComponent(roleId)}?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyListAgreements",
      "List agreements (afspraken) for a circle — intra-circle and cross-circle agreements where this circle holds a party role.",
      z.object({
        circleId: z.string().min(1),
        companyId: companyIdOptional,
      }),
      async ({ circleId, companyId }) =>
        client.requestJson(
          "GET",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(circleId)}/agreements?companyId=${encodeURIComponent(client.resolveCompanyId(companyId))}`,
        ),
    ),

    makeTool(
      "holacracyProposeAgreement",
      "Propose a new agreement between roles in the form 'If condition then commitment'. scope: 'intra_circle' (parties all in primaryCircleId) or 'cross_circle' (parties span circles). Status starts as 'proposed'.",
      z.object({
        companyId: companyIdOptional,
        scope: z.enum(["intra_circle", "cross_circle"]),
        primaryCircleId: z.string().min(1),
        parties: z.array(
          z.object({
            roleId: z.string().min(1),
            circleId: z.string().min(1),
          }),
        ).min(1),
        title: z.string().min(1),
        condition: z.string().optional(),
        commitment: z.string().min(1),
        expiresAt: z.string().optional(),
        proposedViaTensionId: z.string().optional(),
      }),
      async ({ companyId, primaryCircleId, ...body }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/circles/${encodeURIComponent(primaryCircleId)}/agreements`,
          { body: { companyId: client.resolveCompanyId(companyId), primaryCircleId, ...body } },
        ),
    ),

    makeTool(
      "holacracyActivateAgreement",
      "Move an agreement from 'proposed' to 'active'. Stamps activated_at.",
      z.object({
        agreementId: z.string().min(1),
        companyId: companyIdOptional,
      }),
      async ({ agreementId, companyId }) =>
        client.requestJson(
          "POST",
          `/plugins/paperclipai.plugin-holacracy/api/agreements/${encodeURIComponent(agreementId)}/activate`,
          { body: { companyId: client.resolveCompanyId(companyId) } },
        ),
    ),

    // E8 — A2A-over-MQTT peer-messaging tools. Each posts semantic args to
    // /api/internal/a2a/{publish,request}; the server builds the topic via
    // the adapter's topic builders and publishes through the caller's
    // per-agent MQTT client. Broker ACL enforces topic-level authorisation.

    makeTool(
      "a2aSendTask",
      "Send a directed A2A task to a peer agent over MQTT. Publishes on the peer's $a2a/v1/request/{org}/{unit}/{toAgentId} topic with MQTT v5 response-topic + correlation-data, then awaits the reply on the caller's $a2a/v1/reply/.../{taskId} (60s default timeout). Use when you need a specific peer's input — directed, two-way.",
      z.object({
        toAgentId: z.string().uuid(),
        text: z.string().min(1),
        companyId: companyIdOptional,
        contextId: z.string().optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      }),
      async ({ toAgentId, text, companyId, contextId, timeoutMs }) =>
        client.requestJson("POST", "/internal/a2a/request", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "agent",
            toAgentId,
            payload: { text },
            ...(contextId ? { contextId } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        }),
    ),

    makeTool(
      "a2aBroadcastEvent",
      "Publish a fire-and-forget event on your own $a2a/v1/event/{org}/{unit}/{self} topic. Anyone subscribed to your circle's event wildcard receives a copy. Use for general announcements where no specific peer is the target.",
      z.object({
        kind: z.string().min(1),
        body: z.unknown(),
        companyId: companyIdOptional,
      }),
      async ({ kind, body, companyId }) =>
        client.requestJson("POST", "/internal/a2a/publish", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "event-self",
            payload: { kind, body },
          },
        }),
    ),

    makeTool(
      "a2aBroadcastToCircle",
      "Publish a fire-and-forget event scoped to a specific circle (your own or another you belong to). The topic is $a2a/v1/event/{org}/{circleId}/{self} — subscribers to that circle's event wildcard receive it.",
      z.object({
        circleId: z.string().uuid(),
        kind: z.string().min(1),
        body: z.unknown(),
        companyId: companyIdOptional,
      }),
      async ({ circleId, kind, body, companyId }) =>
        client.requestJson("POST", "/internal/a2a/publish", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "event-circle",
            circleId,
            payload: { kind, body },
          },
        }),
    ),

    makeTool(
      "a2aBroadcastToRole",
      "Publish a fire-and-forget event addressed to every filler of a named role in a circle. Useful when the message is role-relevant but you don't care which specific filler reads it first. Receivers all get a copy (not round-robin).",
      z.object({
        circleId: z.string().uuid(),
        roleId: z.string().uuid(),
        kind: z.string().min(1),
        body: z.unknown(),
        companyId: companyIdOptional,
      }),
      async ({ circleId, roleId, kind, body, companyId }) =>
        client.requestJson("POST", "/internal/a2a/publish", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "role-broadcast",
            circleId,
            roleId,
            payload: { kind, body },
          },
        }),
    ),

    makeTool(
      "a2aAskRolePool",
      "Send a task addressed to a role pool — the broker round-robins to exactly ONE filler of the role via shared subscription. Use when any qualified filler can answer; you don't care which.",
      z.object({
        circleId: z.string().uuid(),
        roleId: z.string().uuid(),
        text: z.string().min(1),
        companyId: companyIdOptional,
        contextId: z.string().optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      }),
      async ({ circleId, roleId, text, companyId, contextId, timeoutMs }) =>
        client.requestJson("POST", "/internal/a2a/request", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "role-pool",
            circleId,
            roleId,
            payload: { text },
            ...(contextId ? { contextId } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        }),
    ),

    makeTool(
      "a2aAskSkill",
      "Send a task addressed to a skill pool. Cross-circle by design — the broker round-robins to one agent in the company whose accountability slugifies to the given skill. Use when the task is skill-defined (e.g. 'docs-update', 'data-analysis').",
      z.object({
        skill: z.string().min(1),
        text: z.string().min(1),
        companyId: companyIdOptional,
        contextId: z.string().optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      }),
      async ({ skill, text, companyId, contextId, timeoutMs }) =>
        client.requestJson("POST", "/internal/a2a/request", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "skill-pool",
            skill,
            payload: { text },
            ...(contextId ? { contextId } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        }),
    ),

    makeTool(
      "a2aBroadcastToSkill",
      "Publish a fire-and-forget broadcast to every agent in the company whose accountability matches the given skill (not round-robin). Cross-circle.",
      z.object({
        skill: z.string().min(1),
        kind: z.string().min(1),
        body: z.unknown(),
        companyId: companyIdOptional,
      }),
      async ({ skill, kind, body, companyId }) =>
        client.requestJson("POST", "/internal/a2a/publish", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            kind: "skill-broadcast",
            skill,
            payload: { kind, body },
          },
        }),
    ),

    makeTool(
      "a2aDiscoverAgents",
      "Query the EMQX A2A Registry for live agents. Returns Agent Cards. Optional filters: org_id (companyId), unit_id (circleId), agent_id, skill slug. Use before a2aSendTask when you don't know the target agent id, or to enumerate skill-holders.",
      z.object({
        orgId: z.string().optional(),
        unitId: z.string().optional(),
        agentId: z.string().optional(),
        skill: z.string().optional(),
      }),
      async ({ orgId, unitId, agentId, skill }) => {
        const params = new URLSearchParams();
        if (orgId) params.set("org_id", orgId);
        if (unitId) params.set("unit_id", unitId);
        if (agentId) params.set("agent_id", agentId);
        if (skill) params.set("skill", skill);
        const qs = params.toString();
        return client.requestJson(
          "GET",
          `/internal/a2a/agents${qs ? `?${qs}` : ""}`,
        );
      },
    ),

    makeTool(
      "agentSemanticSkillSearch",
      "Find skills semantically matching a task description. Returns top-K skill candidates + which agents hold them + trust scores. Use this BEFORE agentDelegateTask to find the right peer for a task; or when you're trying to figure out which skill a task needs.",
      z.object({
        taskDescription: z.string().min(1),
        topK: z.number().int().min(1).max(20).optional(),
        companyId: companyIdOptional,
      }),
      async ({ taskDescription, topK, companyId }) =>
        client.requestJson("POST", "/internal/skill-index/search", {
          body: {
            companyId: client.resolveCompanyId(companyId),
            query: taskDescription,
            topK: topK ?? 5,
          },
        }),
    ),
  ];
}
