import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { API_ROUTES, ROLE_TYPES, TOOL_NAMES, type RoleType, DEFAULT_DOMAIN_REGISTRY, GLOBAL_DOMAIN_REGISTRY_COMPANY_ID, GOVERNANCE_APPROVERS, GOVERNANCE_APPROVAL_TIMEOUT_HOURS } from "./constants.js";

interface Circle {
  id: string;
  company_id: string;
  parent_circle_id: string | null;
  name: string;
  purpose: string | null;
  domains: unknown;
  policies: unknown;
  color: string | null;
}

interface Role {
  id: string;
  circle_id: string;
  name: string;
  purpose: string | null;
  role_type: string;
  domains: unknown;
  accountabilities: unknown;
  agent_name?: string;
  agent_id?: string;
}

interface Tension {
  id: string;
  circle_id: string;
  source_agent_id: string | null;
  title: string;
  description: string | null;
  tension_type: string;
  status: string;
}

const CORE_ROLE_DEFS: Array<{ name: string; type: RoleType; purpose: string }> = [
  { name: "Circle Lead", type: ROLE_TYPES.circleLead, purpose: "Hold the circle's overall purpose and manage role assignments" },
  { name: "Facilitator", type: ROLE_TYPES.facilitator, purpose: "Facilitate governance and tactical meetings aligned with the Holacracy constitution" },
  { name: "Secretary", type: ROLE_TYPES.secretary, purpose: "Stabilize the circle's governance records and schedule required meetings" },
  { name: "Circle Rep", type: ROLE_TYPES.circleRep, purpose: "Represent the circle's needs and tensions in the parent circle" },
];

let dbCtx: PluginContext["db"] | null = null;
let httpCtx: PluginContext["http"] | null = null;
let approvalsCtx: PluginContext["approvals"] | null = null;

function tbl(table: string) {
  if (!dbCtx) throw new Error("DB not initialized");
  return `${dbCtx.namespace}.${table}`;
}

async function queryCircleDetail(circleId: string) {
  if (!dbCtx) throw new Error("DB not initialized");
  const circles = await dbCtx.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
  if (circles.length === 0) return null;
  const roles = await dbCtx.query<Role>(
    `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
    [circleId],
  );
  const subCircles = await dbCtx.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE parent_circle_id = $1`, [circleId]);
  const tensions = await dbCtx.query<Tension>(
    `SELECT * FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 10`,
    [circleId],
  );
  return { circle: circles[0], roles, subCircles, tensions };
}

async function createCircle(companyId: string, name: string, purpose: string | null, parentCircleId: string | null, projectId: string | null, color: string | null) {
  if (!dbCtx) throw new Error("DB not initialized");
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("circles")} (id, company_id, name, purpose, parent_circle_id, project_id, color) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, name, purpose, parentCircleId, projectId, color],
  );
  for (const def of CORE_ROLE_DEFS) {
    await dbCtx.execute(
      `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), id, def.name, def.purpose, def.type],
    );
  }
  return { id, name, purpose, parentCircleId, coreRolesCreated: CORE_ROLE_DEFS.length };
}

/**
 * Check if adding these domains to an agent would violate conflict rules.
 * Returns { ok: true } or { ok: false, violation: string }
 * @param excludeRoleId - if provided, ignore the agent's current assignment of this role
 *                       (used during reassignment so a role's own domains don't self-conflict)
 */
async function checkDomainConflict(
  agentId: string,
  newDomains: string[],
  companyId: string,
  excludeRoleId?: string,
): Promise<{ ok: boolean; violation?: string }> {
  if (!dbCtx || newDomains.length === 0) return { ok: true };

  // Get all roles currently assigned to this agent (excluding the role being reassigned, if any)
  const assignments = excludeRoleId
    ? await dbCtx.query<Role>(
        `SELECT r.* FROM ${tbl("roles")} r 
         JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id 
         WHERE ra.agent_id = $1 AND r.id <> $2`,
        [agentId, excludeRoleId],
      )
    : await dbCtx.query<Role>(
        `SELECT r.* FROM ${tbl("roles")} r 
         JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id 
         WHERE ra.agent_id = $1`,
        [agentId],
      );

  // Collect all domains agent already holds
  const existingDomains: Set<string> = new Set();
  for (const role of assignments) {
    const roleDomains = Array.isArray(role.domains) ? role.domains : 
                        typeof role.domains === 'string' ? JSON.parse(role.domains) : [];
    roleDomains.forEach((d: string) => existingDomains.add(d));
  }

  // Get domain conflict registry for this company (plus global defaults via 0-uuid)
  const registry = await dbCtx.query<{ domain_name: string; conflicting_domains: unknown }>(
    `SELECT domain_name, conflicting_domains FROM ${tbl("domain_registry")} WHERE company_id = $1 OR company_id = '00000000-0000-0000-0000-000000000000'`,
    [companyId]
  );

  const conflictMap = new Map<string, string[]>();
  for (const entry of registry) {
    const conflicts = Array.isArray(entry.conflicting_domains) ? entry.conflicting_domains : 
                     typeof entry.conflicting_domains === 'string' ? JSON.parse(entry.conflicting_domains) : [];
    conflictMap.set(entry.domain_name, conflicts as string[]);
  }

  // Bidirectional check: A conflicts with B iff registry says A->B OR B->A
  // 1) New domain explicitly conflicts with an existing domain
  for (const newDomain of newDomains) {
    const conflicts = conflictMap.get(newDomain) || [];
    for (const existing of existingDomains) {
      if (conflicts.includes(existing)) {
        return { 
          ok: false, 
          violation: `Domain conflict: cannot assign "${newDomain}" to agent already holding "${existing}"` 
        };
      }
    }
  }
  // 2) An existing domain explicitly conflicts with a new domain
  for (const existing of existingDomains) {
    const conflicts = conflictMap.get(existing) || [];
    for (const newDomain of newDomains) {
      if (conflicts.includes(newDomain)) {
        return { 
          ok: false, 
          violation: `Domain conflict: agent already holds "${existing}" which conflicts with "${newDomain}"` 
        };
      }
    }
  }
  // 3) New domains conflict with each other (e.g. role grants Sales+Growth in one shot)
  for (let i = 0; i < newDomains.length; i++) {
    const a = newDomains[i];
    const aConflicts = conflictMap.get(a) || [];
    for (let j = i + 1; j < newDomains.length; j++) {
      const b = newDomains[j];
      const bConflicts = conflictMap.get(b) || [];
      if (aConflicts.includes(b) || bConflicts.includes(a)) {
        return { 
          ok: false, 
          violation: `Domain conflict: domains "${a}" and "${b}" cannot coexist on same role` 
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Seed default domain registry entries (idempotent).
 * Uses GLOBAL_DOMAIN_REGISTRY_COMPANY_ID so conflicts apply across all companies
 * unless a per-company override exists.
 */
async function seedDefaultDomainRegistry(): Promise<void> {
  if (!dbCtx) return;
  for (const entry of DEFAULT_DOMAIN_REGISTRY) {
    await dbCtx.execute(
      `INSERT INTO ${tbl("domain_registry")} (id, company_id, domain_name, description, conflicting_domains)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, domain_name) DO UPDATE SET
         description = EXCLUDED.description,
         conflicting_domains = EXCLUDED.conflicting_domains,
         updated_at = NOW()`,
      [
        randomUUID(),
        GLOBAL_DOMAIN_REGISTRY_COMPANY_ID,
        entry.domain,
        entry.description,
        JSON.stringify(entry.conflicts),
      ],
    );
  }
}

/**
 * Create a governance approval on Paperclip for a governance tension.
 * Auto-wires 3 approvers (Strategist, PM, Dev Lead).
 * Uses ctx.approvals SDK capability (no loopback HTTP — SSRF-guard safe).
 * Returns {approvalId} on success or undefined on error.
 */
async function createGovernanceApproval(params: {
  companyId: string;
  tensionId: string;
  title: string;
  description: string | null;
  requestedByAgentId: string | null;
}): Promise<{ approvalId: string } | undefined> {
  if (!approvalsCtx) {
    console.error("[holacracy] approvals capability not initialized");
    return undefined;
  }
  try {
    const approverIds = [
      GOVERNANCE_APPROVERS.strategist,
      GOVERNANCE_APPROVERS.productManager,
      GOVERNANCE_APPROVERS.devLead,
    ];
    const approval = await approvalsCtx.create({
      companyId: params.companyId,
      type: "request_board_approval",
      payload: {
        governance_proposal: {
          tension_id: params.tensionId,
          title: params.title,
          description: params.description ?? "",
        },
        required_approvals: 3,
        approver_agent_ids: approverIds,
        timeout_hours: GOVERNANCE_APPROVAL_TIMEOUT_HOURS,
        on_timeout: "escalate_to_operator",
      },
      requestedByAgentId: params.requestedByAgentId ?? null,
    });
    return { approvalId: approval.id };
  } catch (err) {
    console.error(
      "[holacracy] createGovernanceApproval error:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    dbCtx = ctx.db;
    httpCtx = ctx.http;
    approvalsCtx = ctx.approvals;
    // Seed global domain registry (idempotent, runs once per plugin start)
    try {
      await seedDefaultDomainRegistry();
    } catch (err) {
      // Migration may not have applied yet; log but don't crash plugin
      console.warn("[holacracy] domain_registry seed skipped:", err instanceof Error ? err.message : String(err));
    }

    ctx.data.register("circles-tree", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      const circles = await ctx.db.query<Circle>(
        `SELECT * FROM ${tbl("circles")} WHERE company_id = $1 ORDER BY parent_circle_id NULLS FIRST, name`,
        [companyId],
      );
      const result = [];
      for (const c of circles) {
        const roles = await ctx.db.query<Role>(
          `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
          [c.id],
        );
        result.push({ ...c, roles });
      }
      return result;
    });

    ctx.data.register("tensions-cross-circle", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      return ctx.db.query<Tension & { circle_name: string; source_circle_name: string }>(
        `SELECT t.*, c.name as circle_name FROM ${tbl("tensions")} t JOIN ${tbl("circles")} c ON c.id = t.circle_id WHERE c.company_id = $1 AND t.title LIKE '[Forwarded]%' ORDER BY t.created_at DESC LIMIT 20`,
        [companyId],
      );
    });

    ctx.data.register("circle-governance", async (params) => {
      const circleId = params.circleId as string;
      if (!circleId) return null;
      const strategies = await ctx.db.query(
        `SELECT s.*, a.name as set_by_name FROM ${tbl("strategies")} s LEFT JOIN public.agents a ON a.id = s.set_by WHERE s.circle_id = $1 AND s.active = true ORDER BY s.created_at DESC`,
        [circleId],
      );
      const policies = await ctx.db.query(
        `SELECT * FROM ${tbl("policies")} WHERE circle_id = $1 ORDER BY created_at DESC`,
        [circleId],
      );
      const checklists = await ctx.db.query(
        `SELECT cl.*, r.name as role_name FROM ${tbl("checklists")} cl LEFT JOIN ${tbl("roles")} r ON r.id = cl.role_id WHERE cl.circle_id = $1 ORDER BY cl.frequency, cl.created_at`,
        [circleId],
      );
      const metrics = await ctx.db.query(
        `SELECT m.*, r.name as role_name FROM ${tbl("metrics")} m LEFT JOIN ${tbl("roles")} r ON r.id = m.role_id WHERE m.circle_id = $1 ORDER BY m.frequency, m.created_at`,
        [circleId],
      );
      return { strategies, policies, checklists, metrics };
    });

    ctx.data.register("governance-summary", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return null;
      const circles = await ctx.db.query(
        `SELECT c.id, c.name, c.purpose, c.domains, c.color FROM ${tbl("circles")} c WHERE c.company_id = $1 ORDER BY c.parent_circle_id NULLS FIRST, c.name`,
        [companyId],
      );
      const result = [];
      for (const c of circles) {
        const stratCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("strategies")} WHERE circle_id = $1 AND active = true`, [c.id]);
        const polCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("policies")} WHERE circle_id = $1`, [c.id]);
        const clCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("checklists")} WHERE circle_id = $1`, [c.id]);
        const metCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("metrics")} WHERE circle_id = $1`, [c.id]);
        const tensionCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open'`, [c.id]);
        result.push({
          ...c,
          strategiesCount: stratCount[0]?.count ?? 0,
          policiesCount: polCount[0]?.count ?? 0,
          checklistsCount: clCount[0]?.count ?? 0,
          metricsCount: metCount[0]?.count ?? 0,
          openTensionsCount: tensionCount[0]?.count ?? 0,
        });
      }
      return result;
    });

    ctx.data.register("agent-role", async (params) => {
      const agentId = params.agentId as string;
      if (!agentId) return null;
      const assignments = await ctx.db.query(
        `SELECT ra.*, r.name as role_name, r.purpose as role_purpose, r.role_type, r.accountabilities, r.domains, c.id as circle_id, c.name as circle_name, c.purpose as circle_purpose FROM ${tbl("role_assignments")} ra JOIN ${tbl("roles")} r ON r.id = ra.role_id JOIN ${tbl("circles")} c ON c.id = r.circle_id WHERE ra.agent_id = $1`,
        [agentId],
      );
      if (assignments.length === 0) return null;
      const assignment = assignments[0];
      const checklists = await ctx.db.query(
        `SELECT * FROM ${tbl("checklists")} WHERE role_id = $1 ORDER BY frequency, created_at`,
        [assignment.role_id],
      );
      const metrics = await ctx.db.query(
        `SELECT * FROM ${tbl("metrics")} WHERE role_id = $1 ORDER BY frequency, created_at`,
        [assignment.role_id],
      );
      const tensions = await ctx.db.query(
        `SELECT * FROM ${tbl("tensions")} WHERE circle_id = $1 AND source_agent_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 5`,
        [assignment.circle_id, agentId],
      );
      return { ...assignment, checklists, metrics, tensions };
    });

    ctx.data.register("circle-audit-log", async (params) => {
      const circleId = params.circleId as string;
      if (!circleId) return [];
      return ctx.db.query(
        `SELECT al.*, a.name as agent_name FROM ${tbl("audit_log")} al LEFT JOIN public.agents a ON a.id = al.agent_id WHERE al.circle_id = $1 ORDER BY al.created_at DESC LIMIT 20`,
        [circleId],
      );
    });

    ctx.data.register("tensions-board", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return { tensions: [], circles: [] };
      const tensions = await ctx.db.query(
        `SELECT t.*, c.name as circle_name, a.name as source_agent_name
         FROM ${tbl("tensions")} t
         JOIN ${tbl("circles")} c ON c.id = t.circle_id
         LEFT JOIN public.agents a ON a.id = t.source_agent_id
         WHERE c.company_id = $1
         ORDER BY t.created_at DESC`,
        [companyId],
      );
      const circles = await ctx.db.query(
        `SELECT id, name FROM ${tbl("circles")} WHERE company_id = $1 ORDER BY name`,
        [companyId],
      );
      return { tensions, circles };
    });

    ctx.tools.register(
      TOOL_NAMES.getCircle,
      { displayName: "Get Holacracy Circle", description: "Get a circle's structure including purpose, roles, sub-circles, and policies", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const detail = await queryCircleDetail((params as { circleId: string }).circleId);
        if (!detail) return { content: "Circle not found", error: "not found" };
        return { content: JSON.stringify(detail, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.getRole,
      { displayName: "Get Holacracy Role", description: "Get a role's details including purpose, accountabilities, domains, and assignments", parametersSchema: { type: "object", properties: { roleId: { type: "string" } }, required: ["roleId"] } },
      async (params): Promise<ToolResult> => {
        const { roleId } = params as { roleId: string };
        const roles = await dbCtx!.query<Role>(`SELECT * FROM ${tbl("roles")} WHERE id = $1`, [roleId]);
        if (roles.length === 0) return { content: "Role not found", error: "not found" };
        const assignments = await dbCtx!.query<{ agent_id: string; agent_name: string; focus_ap: number }>(
          `SELECT ra.agent_id, a.name as agent_name, ra.focus_ap FROM ${tbl("role_assignments")} ra JOIN public.agents a ON a.id = ra.agent_id WHERE ra.role_id = $1`,
          [roleId],
        );
        return { content: JSON.stringify({ role: roles[0], filledBy: assignments }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listTensions,
      { displayName: "List Circle Tensions", description: "List open tensions in a circle, optionally filtered by type", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, type: { type: "string", enum: ["operational", "governance", "all"] } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId, type: tt } = params as { circleId: string; type?: string };
        const filter = tt && tt !== "all" ? " AND tension_type = $2" : "";
        const args = filter ? [circleId, tt] : [circleId];
        const tensions = await dbCtx!.query<Tension>(
          `SELECT * FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open'${filter} ORDER BY created_at DESC`,
          args,
        );
        return { content: JSON.stringify({ tensions, count: tensions.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.raiseTension,
      { displayName: "Raise Tension", description: "Raise a tension in a circle for processing in the next meeting", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, type: { type: "string", enum: ["operational", "governance"] } }, required: ["circleId", "title", "description", "type"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, title, description, type: tensionType } = params as { circleId: string; title: string; description: string; type: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, circleId, runCtx.agentId ?? null, title, description, tensionType],
        );
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
          [runCtx.companyId, runCtx.agentId ?? null, circleId, JSON.stringify({ tensionId: id, title, type: tensionType })],
        );

        // Trigger A: governance tension → auto-create 3-of-3 async approval
        let approvalId: string | undefined;
        if (tensionType === "governance") {
          const approvalResult = await createGovernanceApproval({
            companyId: runCtx.companyId,
            tensionId: id,
            title,
            description: description ?? null,
            requestedByAgentId: runCtx.agentId ?? null,
          });
          if (approvalResult) {
            approvalId = approvalResult.approvalId;
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'governance-approval-created', $3)`,
              [runCtx.companyId, circleId, JSON.stringify({ tensionId: id, approvalId: approvalResult.approvalId })],
            );
          }
        }

        return {
          content: JSON.stringify({
            tensionId: id,
            status: "open",
            message: `Tension raised: "${title}" (${tensionType})`,
            ...(approvalId ? { approvalId, approvalStatus: "pending" } : {}),
          }),
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.checkAuthority,
      { displayName: "Check Authority", description: "Check if an action is within your role's authority scope", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, roleId: { type: "string" }, proposedAction: { type: "string", enum: ["assign-role", "update-policy", "create-project", "escalate", "set-strategy", "modify-governance"] } }, required: ["circleId", "roleId", "proposedAction"] } },
      async (params): Promise<ToolResult> => {
        const { circleId, roleId, proposedAction } = params as { circleId: string; roleId: string; proposedAction: string };
        const roles = await dbCtx!.query<Role>(`SELECT * FROM ${tbl("roles")} WHERE id = $1 AND circle_id = $2`, [roleId, circleId]);
        if (roles.length === 0) return { content: JSON.stringify({ authorized: false, reason: "Role not found in this circle" }) };
        const role = roles[0];
        const authorityMap: Record<string, string[]> = {
          "circle_lead": ["assign-role", "create-project", "set-strategy", "escalate"],
          "facilitator": ["escalate"],
          "secretary": ["escalate"],
          "circle_rep": ["escalate"],
        };
        const structuralActions = ["update-policy", "modify-governance"];
        if (structuralActions.includes(proposedAction)) {
          return { content: JSON.stringify({ authorized: false, reason: "Structural changes require governance process. Raise a governance tension instead.", escalateTo: "governance-tension" }) };
        }
        const allowed = authorityMap[role.role_type] ?? [];
        if (allowed.includes(proposedAction)) {
          return { content: JSON.stringify({ authorized: true, reason: `Action "${proposedAction}" is within ${role.role_type} authority scope` }) };
        }
        return { content: JSON.stringify({ authorized: false, reason: `Action "${proposedAction}" is not within ${role.role_type} authority. Consider escalating.`, escalateTo: "circle-lead" }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.logAction,
      { displayName: "Log Action", description: "Log an action taken in your role for the audit trail", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, actionType: { type: "string", enum: ["decision", "delegation", "tension-raised", "escalation", "role-change", "policy-change"] }, detail: { type: "string" } }, required: ["circleId", "actionType", "detail"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, actionType, detail } = params as { circleId: string; actionType: string; detail: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (id, company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, (SELECT company_id FROM ${tbl("circles")} WHERE id = $2), $3, $2, $4, $5)`,
          [id, circleId, runCtx.agentId ?? null, actionType, JSON.stringify({ detail })],
        );
        return { content: JSON.stringify({ logged: true, id, actionType, detail }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.forwardTension,
      { displayName: "Forward Tension", description: "Forward a tension from your circle to the parent circle (Circle Rep only)", parametersSchema: { type: "object", properties: { tensionId: { type: "string" }, context: { type: "string" } }, required: ["tensionId", "context"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { tensionId, context } = params as { tensionId: string; context: string };
        const tensions = await dbCtx!.query<Tension>(`SELECT * FROM ${tbl("tensions")} WHERE id = $1`, [tensionId]);
        if (tensions.length === 0) return { content: "Tension not found", error: "not found" };
        const sourceTension = tensions[0];
        const circles = await dbCtx!.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [sourceTension.circle_id]);
        if (!circles[0]?.parent_circle_id) return { content: "Circle has no parent circle to forward to", error: "no parent" };
        const forwardedId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [forwardedId, circles[0].parent_circle_id, runCtx.agentId ?? sourceTension.source_agent_id, `[Forwarded] ${sourceTension.title}`, `${context}\n\n---\nOriginal tension from ${circles[0].name}: ${sourceTension.description ?? ""}`, sourceTension.tension_type],
        );
        await dbCtx!.execute(`UPDATE ${tbl("tensions")} SET status = 'processing' WHERE id = $1`, [tensionId]);
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ((SELECT company_id FROM ${tbl("circles")} WHERE id = $1), $2, $1, 'tension-forwarded', $3)`,
          [sourceTension.circle_id, runCtx.agentId ?? null, JSON.stringify({ originalTensionId: tensionId, forwardedTensionId: forwardedId, context })],
        );
        return { content: JSON.stringify({ forwardedTensionId: forwardedId, targetCircleId: circles[0].parent_circle_id, status: "forwarded" }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listPolicies,
      { displayName: "List Policies", description: "List policies governing a circle's domains", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId } = params as { circleId: string };
        const policies = await dbCtx!.query(`SELECT * FROM ${tbl("policies")} WHERE circle_id = $1 ORDER BY created_at DESC`, [circleId]);
        return { content: JSON.stringify({ policies, count: policies.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.setStrategy,
      { displayName: "Set Strategy", description: "Set a strategy for your circle (Circle Lead only)", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, text: { type: "string" } }, required: ["circleId", "text"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, text } = params as { circleId: string; text: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("strategies")} (id, circle_id, text, set_by) VALUES ($1, $2, $3, $4)`,
          [id, circleId, text, runCtx.agentId ?? null],
        );
        return { content: JSON.stringify({ strategyId: id, text, status: "active" }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.reportChecklist,
      { displayName: "Report Checklist", description: "Report check/no-check on your recurring checklist items", parametersSchema: { type: "object", properties: { checklistId: { type: "string" }, checked: { type: "boolean" }, periodDate: { type: "string" } }, required: ["checklistId", "checked", "periodDate"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { checklistId, checked, periodDate } = params as { checklistId: string; checked: boolean; periodDate: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("checklist_responses")} (id, checklist_id, agent_id, checked, period_date) VALUES ($1, $2, $3, $4, $5)`,
          [id, checklistId, runCtx.agentId ?? null, checked, periodDate],
        );
        return { content: JSON.stringify({ reported: true, checklistId, checked, periodDate }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.reportMetric,
      { displayName: "Report Metric", description: "Report a metric value for the current period", parametersSchema: { type: "object", properties: { metricId: { type: "string" }, value: { type: "number" }, periodDate: { type: "string" } }, required: ["metricId", "value", "periodDate"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { metricId, value, periodDate } = params as { metricId: string; value: number; periodDate: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("metric_values")} (id, metric_id, value, period_date, reported_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, metricId, value, periodDate, runCtx.agentId ?? null],
        );
        return { content: JSON.stringify({ reported: true, metricId, value, periodDate }) };
      },
    );

    // Governance approval timeout scanner job
    ctx.jobs.register("governance-approval-timeout-scanner", async (_job) => {
      // Query approvals directly via dbCtx (approvals is in coreReadTables)
      const circles = await dbCtx!.query<{ company_id: string; id: string }>(
        `SELECT DISTINCT company_id FROM ${tbl("circles")}`,
        [],
      );
      const companyIds = [...new Set(circles.map((c) => c.company_id))];

      for (const companyId of companyIds) {
        const pendingApprovals = await dbCtx!.query<{
          id: string;
          type: string;
          status: string;
          payload: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT id, type, status, payload, created_at FROM public.approvals WHERE company_id = $1 AND status = 'pending' AND type = 'request_board_approval'`,
          [companyId],
        );

        for (const approval of pendingApprovals) {
          const payload = (approval.payload as Record<string, unknown>) ?? {};
          if (payload["on_timeout"] !== "escalate_to_operator") continue;
          const timeoutHours = typeof payload["timeout_hours"] === "number" ? payload["timeout_hours"] : GOVERNANCE_APPROVAL_TIMEOUT_HOURS;
          const createdAt = new Date(approval.created_at).getTime();
          const expiresAt = createdAt + timeoutHours * 60 * 60 * 1000;
          if (Date.now() < expiresAt) continue;

          // Expired — mark as rejected via direct DB update
          await dbCtx!.execute(
            `UPDATE public.approvals SET status = 'rejected', decision_note = $2, decided_at = NOW() WHERE id = $1`,
            [approval.id, `auto:timed_out — governance proposal expired after ${timeoutHours}h with no decision. Operator review required.`],
          );

          // Log escalation activity
          await ctx.activity.log({
            companyId,
            message: `[GOVERNANCE TIMEOUT] Approval ${approval.id} expired after ${timeoutHours}h with no decision. Governance proposal: "${(payload["governance_proposal"] as Record<string, unknown>)?.["title"] ?? "unknown"}". Escalated to operator — manual review required.`,
            entityType: "approval",
            entityId: approval.id,
            metadata: {
              approvalId: approval.id,
              timeoutHours,
              expiresAt: new Date(expiresAt).toISOString(),
              governanceProposal: payload["governance_proposal"],
              patchStatus: "rejected_timed_out",
            },
          });
        }
      }
    });

    // -----------------------------------------------------------------------
    // Accountability Scanner — MYA-78
    // Runs daily at 03:00. For each agent, evaluates due accountabilities and
    // raises operational tensions on breach.
    // Idempotency key: [SCAN:{agent_id}:{acc_name}:{scan_date}] in title.
    // -----------------------------------------------------------------------
    ctx.jobs.register("accountability-scanner", async (_job) => {
      // All data access via dbCtx — no HTTP calls needed (no http.outbound capability required).

      const cadenceIsDue = (cadence: string, now: Date): boolean => {
        if (cadence === "daily" || cadence === "hourly") return true;
        if (cadence === "weekly") return now.getDay() === 1; // Monday
        if (cadence === "monthly") return now.getDate() === 1;
        return false;
      };

      type EvalResult = { value: number | boolean | null; breached: boolean };
      const evaluateAccountability = async (
        agentId: string,
        companyId: string,
        acc: Record<string, unknown>,
      ): Promise<EvalResult> => {
        const name = String(acc.name ?? "");
        const threshold = acc.alert_threshold;

        if (name === "agent_active") {
          const rows = await dbCtx!.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND (status = 'in_progress' OR (status = 'done' AND completed_at >= date_trunc('month', NOW())))`,
            [companyId, agentId],
          );
          const active = (rows[0]?.count ?? 0) > 0;
          return { value: active, breached: !active };
        }
        if (name === "pr_review_latency_hours" || name.includes("latency_hours") || name.includes("turnaround_hours")) {
          const rows = await dbCtx!.query<{ avg_hours: number | null }>(
            `SELECT EXTRACT(EPOCH FROM AVG(NOW() - updated_at))/3600 as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_progress' AND updated_at < NOW() - INTERVAL '24 hours'`,
            [companyId, agentId],
          );
          const avg = rows[0]?.avg_hours ?? 0;
          return { value: Math.round(avg * 10) / 10, breached: avg > Number(threshold) };
        }
        if (name === "unrouted_backlog_count") {
          const rows = await dbCtx!.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id IS NULL AND status = 'backlog' AND created_at < NOW() - INTERVAL '24 hours'`,
            [companyId],
          );
          const count = rows[0]?.count ?? 0;
          return { value: count, breached: count > Number(threshold) };
        }
        if (name === "engineering_issues_completed_weekly" || name.includes("completed") || name.includes("published") || name.includes("groomed") || name.includes("deployed") || name.includes("resolved")) {
          const rows = await dbCtx!.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= NOW() - INTERVAL '7 days'`,
            [companyId, agentId],
          );
          const count = rows[0]?.count ?? 0;
          return { value: count, breached: count < Number(threshold ?? 0) };
        }
        // Unknown metric — skip
        return { value: null, breached: false };
      };

      // --------------- main scan loop ---------------
      const companyRows = await dbCtx!.query<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM ${tbl("circles")}`,
        [],
      );

      let raised = 0;
      let skipped = 0;
      const now = new Date();
      const scanDate = now.toISOString().split("T")[0];

      for (const { company_id: companyId } of companyRows) {
        // Load agents with accountabilities directly from DB
        const agents = await dbCtx!.query<{
          id: string;
          name: string;
          accountabilities: Array<Record<string, unknown>>;
        }>(
          `SELECT id, name, accountabilities FROM public.agents WHERE company_id = $1 AND status != 'deleted'`,
          [companyId],
        );

        // Find GCC (root circle) as fallback
        const gccRows = await dbCtx!.query<{ id: string }>(
          `SELECT id FROM ${tbl("circles")} WHERE company_id = $1 AND parent_circle_id IS NULL LIMIT 1`,
          [companyId],
        );
        const fallbackCircleId = gccRows[0]?.id;
        if (!fallbackCircleId) continue;

        for (const agent of agents) {
          const agentId = agent.id;
          const agentName = agent.name ?? agentId;
          const accountabilities = Array.isArray(agent.accountabilities) ? agent.accountabilities : [];
          if (accountabilities.length === 0) continue;

          // Determine primary circle from role assignments
          const roleRows = await dbCtx!.query<{ circle_id: string }>(
            `SELECT r.circle_id FROM ${tbl("role_assignments")} ra JOIN ${tbl("roles")} r ON r.id = ra.role_id WHERE ra.agent_id = $1 LIMIT 1`,
            [agentId],
          );
          const circleId = roleRows[0]?.circle_id ?? fallbackCircleId;

          for (const acc of accountabilities) {
            const cadence = String(acc.cadence ?? "daily");
            if (!cadenceIsDue(cadence, now)) continue;

            const accName = String(acc.name ?? "unknown");
            const idempotencyKey = `scan:${agentId}:${accName}:${scanDate}`;

            // Idempotency: skip if tension already filed today
            const existing = await dbCtx!.query<{ id: string }>(
              `SELECT id FROM ${tbl("tensions")} WHERE idempotency_key = $1 LIMIT 1`,
              [idempotencyKey],
            );
            if (existing.length > 0) { skipped++; continue; }

            const { value, breached } = await evaluateAccountability(agentId, companyId, acc);
            if (!breached) continue;

            const threshold = acc.alert_threshold;
            const tensionId = randomUUID();
            const title = `[Scanner] ${agentName} breached ${accName}: ${value} vs threshold ${threshold}`;
            const description = JSON.stringify({
              agent_id: agentId,
              agent_name: agentName,
              accountability_name: accName,
              metric_value: value,
              threshold,
              cadence,
              observed_at: now.toISOString(),
              scan_date: scanDate,
              escalation_path: acc.escalation_path ?? [],
            });

            await dbCtx!.execute(
              `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type, idempotency_key) VALUES ($1, $2, $3, $4, $5, 'operational', $6)`,
              [tensionId, circleId, agentId, title, description, idempotencyKey],
            );

            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
              [companyId, agentId, circleId, JSON.stringify({ tensionId, source: "accountability-scanner", accountability: accName, scanDate })],
            );

            raised++;
            await ctx.activity.log({
              companyId,
              message: `[ACCOUNTABILITY BREACH] ${agentName} / ${accName}: ${value} vs threshold ${threshold}. Tension ${tensionId} raised.`,
              entityType: "agent",
              entityId: agentId,
              metadata: { tensionId, agentId, accName, value, threshold, circleId, scanDate },
            });
          }
        }
      }

      await ctx.activity.log({
        companyId: companyRows[0]?.company_id ?? "unknown",
        message: `[ACCOUNTABILITY SCAN] ${scanDate} complete. Tensions raised: ${raised}, skipped (dedup): ${skipped}.`,
        entityType: "system",
        entityId: "accountability-scanner",
        metadata: { raised, skipped, scanDate },
      });
    });

    ctx.tools.register(
      TOOL_NAMES.onboardAgent,
      { displayName: "Onboard Agent", description: "Create a custom role in a circle and prepare onboarding. Circle Lead only.", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, agentName: { type: "string" }, roleName: { type: "string" }, rolePurpose: { type: "string" }, roleAccountabilities: { type: "array", items: { type: "string" } }, roleDomains: { type: "array", items: { type: "string" } } }, required: ["circleId", "agentName", "roleName", "rolePurpose"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, agentName, roleName, rolePurpose, roleAccountabilities, roleDomains } = params as {
          circleId: string; agentName: string; roleName: string; rolePurpose: string;
          roleAccountabilities?: string[]; roleDomains?: string[];
        };
        const circles = await dbCtx!.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        if (circles.length === 0) return { content: "Circle not found", error: "not found" };
        const circle = circles[0];
        const roleId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, 'custom', $5, $6)`,
          [roleId, circleId, roleName, rolePurpose, JSON.stringify(roleAccountabilities ?? []), JSON.stringify(roleDomains ?? [])],
        );
        const strategies = await dbCtx!.query(`SELECT s.text, a.name as set_by_name FROM ${tbl("strategies")} s LEFT JOIN public.agents a ON a.id = s.set_by WHERE s.circle_id = $1 AND s.active = true`, [circleId]);
        const policies = await dbCtx!.query(`SELECT title, domain, description FROM ${tbl("policies")} WHERE circle_id = $1`, [circleId]);
        const roles = await dbCtx!.query(`SELECT r.name, r.purpose, r.role_type, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`, [circleId]);
        const teamList = roles.map((r: any) => `- ${r.agent_name ?? "(vacant)"}: ${r.name} -- ${r.purpose ?? ""}`).join("\n");
        const strategyText = strategies.length > 0 ? (strategies[0] as any).text : "No strategy set";
        const policyList = policies.map((p: any) => `- ${p.title}${p.domain ? ` (${p.domain})` : ""}: ${p.description}`).join("\n");
        const holacracyRoleMd = `# Holacracy Role: ${roleName}
## Circle: ${circle.name}
**Circle Purpose:** ${circle.purpose ?? ""}

## Your Role
**Role Purpose:** ${rolePurpose}
You fill the ${roleName} role in the ${circle.name} circle.

## Accountabilities
${(roleAccountabilities ?? []).map(a => `- ${a}`).join("\n") || "- (none defined yet)"}

## Authority & Constraints
- You MAY act autonomously within your role's accountabilities
- You CANNOT modify governance -- raise governance tensions instead
- You CANNOT act on domains owned by other roles without permission

## AI Agent Protocol
- Act only within your role's scope. Escalate anything outside it.
- Every action is logged. Act transparently.
- Your role can be modified through governance. You do not modify your own role.
- Use holacracy-get-circle and holacracy-get-role tools to understand org context before acting.
- Principle: "Prompts reference the org map. The org map does not reference prompts."

## Tensions
A tension = gap between current reality and potential you see for your role.
- Operational: things you need to get work done. Raise via holacracy-raise-tension with type "operational".
- Governance: structural issues about roles/accountabilities/policies. Raise with type "governance".

## Two-Tier Authority
- **Operational decisions** within your role scope: act autonomously, no approval needed.
- **Structural changes** (modifying roles, domains, policies): raise as governance tension for human review.

## Your Circle Team
${teamList}

## Active Strategy
"${strategyText}"
All operational decisions should align with this strategy.

## Relevant Policies
${policyList || "No policies defined yet."}

## Error Protocol
1. Log the action via holacracy-log-action with actionType "escalation"
2. If the error was within your role scope: fix it and document what happened
3. If the error was structural (your role definition was inadequate): raise a governance tension
4. The audit trail is your protection -- transparent logging demonstrates good faith`;

        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'agent-onboarded', $4)`,
          [circle.company_id, runCtx.agentId ?? null, circleId, JSON.stringify({ roleId, roleName, agentName, rolePurpose })],
        );
        return { content: JSON.stringify({
          roleId,
          roleName,
          circleId,
          circleName: circle.name,
          agentName,
          holacracyRoleMd,
          nextSteps: [
            `1. Create agent "${agentName}" using paperclip-create-agent skill`,
            `2. Assign agent to role: PATCH /api/plugins/paperclipai.plugin-holacracy/api/circles/${circleId}/roles/${roleId}/assign with {"companyId":"${circle.company_id}","agentId":"<new-agent-id>"}`,
            `3. Push holacracy-role.md: PUT /api/agents/<new-agent-id>/instructions-bundle/file with {"path":"holacracy-role.md","content":"<the holacracyRoleMd above>"}`,
          ],
        }, null, 2) };
      },
    );
  },

  async onApiRequest(input: PluginApiRequestInput) {
    try {
    switch (input.routeKey) {
      case API_ROUTES.listCircles: {
        const companyId = input.companyId;
        const circles = await dbCtx!.query<Circle>(
          `SELECT * FROM ${tbl("circles")} WHERE company_id = $1 ORDER BY parent_circle_id NULLS FIRST, name`,
          [companyId],
        );
        return { status: 200, body: circles };
      }

      case API_ROUTES.getCircle: {
        const detail = await queryCircleDetail(input.params.circleId as string);
        if (!detail) return { status: 404, body: { error: "Circle not found" } };
        return { status: 200, body: detail };
      }

      case API_ROUTES.createCircle: {
        const { name, purpose, parentCircleId, projectId, color } = input.body as {
          name: string; purpose?: string; parentCircleId?: string; projectId?: string; color?: string;
        };
        const result = await createCircle(input.companyId, name, purpose ?? null, parentCircleId ?? null, projectId ?? null, color ?? null);
        return { status: 201, body: result };
      }

      case API_ROUTES.listRoles: {
        const circleId = input.params.circleId as string;
        const roles = await dbCtx!.query<Role>(
          `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
          [circleId],
        );
        return { status: 200, body: roles };
      }

      case API_ROUTES.assignRole: {
        const circleId = input.params.circleId as string;
        const { roleName, roleType, purpose, accountabilities, domains, agentId } = input.body as {
          roleName: string; roleType?: string; purpose?: string; accountabilities?: string[]; domains?: string[]; agentId?: string;
        };

        // Check domain conflicts if assigning to agent
        if (agentId && domains && domains.length > 0) {
          const conflict = await checkDomainConflict(agentId, domains, input.companyId);
          if (!conflict.ok) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
              [input.companyId, agentId, circleId, JSON.stringify({ violation: conflict.violation, roleName, domains, route: "assignRole" })],
            );
            return { status: 409, body: { error: conflict.violation } };
          }
        }

        const roleId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [roleId, circleId, roleName, purpose ?? null, roleType ?? "custom", JSON.stringify(accountabilities ?? []), JSON.stringify(domains ?? [])],
        );
        if (agentId) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }
        return { status: 201, body: { roleId, roleName, circleId, agentId } };
      }

      case API_ROUTES.updateRole: {
        const circleId = input.params.circleId as string;
        const roleId = input.params.roleId as string;
        const { purpose, accountabilities, domains, name } = input.body as {
          purpose?: string; accountabilities?: string[]; domains?: string[]; name?: string; companyId: string;
        };

        // If domains changing on a role that has an active assignee, validate against registry.
        if (domains !== undefined && domains.length > 0) {
          const assignee = await dbCtx!.query<{ agent_id: string }>(
            `SELECT agent_id FROM ${tbl("role_assignments")} WHERE role_id = $1 LIMIT 1`,
            [roleId],
          );
          if (assignee.length > 0 && assignee[0].agent_id) {
            const conflict = await checkDomainConflict(assignee[0].agent_id, domains, input.companyId, roleId);
            if (!conflict.ok) {
              await dbCtx!.execute(
                `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, role_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-domain-update-rejected', $4)`,
                [input.companyId, assignee[0].agent_id, roleId, JSON.stringify({ violation: conflict.violation, domains, route: "updateRole" })],
              );
              return { status: 409, body: { error: conflict.violation } };
            }
          }
        }

        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (purpose !== undefined) { sets.push(`purpose = $${idx++}`); vals.push(purpose); }
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (accountabilities !== undefined) { sets.push(`accountabilities = $${idx++}`); vals.push(JSON.stringify(accountabilities)); }
        if (domains !== undefined) { sets.push(`domains = $${idx++}`); vals.push(JSON.stringify(domains)); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        sets.push(`updated_at = NOW()`);
        vals.push(roleId, circleId);
        await dbCtx!.execute(
          `UPDATE ${tbl("roles")} SET ${sets.join(", ")} WHERE id = $${idx++} AND circle_id = $${idx}`,
          vals,
        );
        const updated = await dbCtx!.query(`SELECT * FROM ${tbl("roles")} WHERE id = $1`, [roleId]);
        return { status: 200, body: updated[0] ?? { error: "Role not found" } };
      }

      case API_ROUTES.updateCircle: {
        const circleId = input.params.circleId as string;
        const { purpose, name, color, domains, policies } = input.body as {
          purpose?: string; name?: string; color?: string; domains?: unknown; policies?: unknown; companyId: string;
        };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (purpose !== undefined) { sets.push(`purpose = $${idx++}`); vals.push(purpose); }
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (color !== undefined) { sets.push(`color = $${idx++}`); vals.push(color); }
        if (domains !== undefined) { sets.push(`domains = $${idx++}`); vals.push(JSON.stringify(domains)); }
        if (policies !== undefined) { sets.push(`policies = $${idx++}`); vals.push(JSON.stringify(policies)); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        sets.push(`updated_at = NOW()`);
        vals.push(circleId);
        await dbCtx!.execute(
          `UPDATE ${tbl("circles")} SET ${sets.join(", ")} WHERE id = $${idx}`,
          vals,
        );
        const updated = await dbCtx!.query(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        return { status: 200, body: updated[0] ?? { error: "Circle not found" } };
      }

      case API_ROUTES.updateRoleAssignment: {
        const roleId = input.params.roleId as string;
        const { agentId } = input.body as { agentId: string | null; companyId: string };

        // Check domain conflicts before reassignment
        if (agentId) {
          const roleRows = await dbCtx!.query<Role>(
            `SELECT * FROM ${tbl("roles")} WHERE id = $1`,
            [roleId],
          );
          if (roleRows.length === 0) return { status: 404, body: { error: "Role not found" } };
          const role = roleRows[0];
          const roleDomains = Array.isArray(role.domains) ? role.domains :
                              typeof role.domains === 'string' ? JSON.parse(role.domains) : [];
          if (roleDomains.length > 0) {
            // Exclude the current assignment of THIS role from the conflict check
            // (re-assigning same role to same agent should not self-conflict)
            const conflict = await checkDomainConflict(agentId, roleDomains, input.companyId, roleId);
            if (!conflict.ok) {
              await dbCtx!.execute(
                `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, role_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
                [input.companyId, agentId, roleId, JSON.stringify({ violation: conflict.violation, domains: roleDomains, route: "updateRoleAssignment" })],
              );
              return { status: 409, body: { error: conflict.violation } };
            }
          }
        }

        await dbCtx!.execute(`DELETE FROM ${tbl("role_assignments")} WHERE role_id = $1`, [roleId]);
        if (agentId) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }
        return { status: 200, body: { roleId, agentId } };
      }

      case API_ROUTES.deleteCircle: {
        const circleId = input.params.circleId as string;
        await dbCtx!.execute(`DELETE FROM ${tbl("tensions")} WHERE circle_id = $1`, [circleId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("role_assignments")} WHERE role_id IN (SELECT id FROM ${tbl("roles")} WHERE circle_id = $1)`, [circleId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("roles")} WHERE circle_id = $1`, [circleId]);
        await dbCtx!.execute(`UPDATE ${tbl("circles")} SET parent_circle_id = NULL WHERE parent_circle_id = $1`, [circleId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        return { status: 200, body: { deleted: circleId } };
      }

      case API_ROUTES.listTensions: {
        const circleId = input.params.circleId as string;
        const type = input.query?.type as string | undefined;
        const filter = type && type !== "all" ? " AND tension_type = $2" : "";
        const params: unknown[] = filter ? [circleId, type] : [circleId];
        const tensions = await dbCtx!.query<Tension>(
          `SELECT t.*, a.name as agent_name FROM ${tbl("tensions")} t LEFT JOIN public.agents a ON a.id = t.source_agent_id WHERE t.circle_id = $1 AND t.status = 'open'${filter} ORDER BY t.created_at DESC`,
          params,
        );
        return { status: 200, body: tensions };
      }

      case API_ROUTES.raiseTension: {
        const circleId = input.params.circleId as string;
        const { title, description, type: tensionType } = input.body as { title: string; description?: string; type?: string; companyId: string };
        if (!title) return { status: 400, body: { error: "title is required" } };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, circleId, null, title, description ?? null, tensionType ?? "operational"],
        );
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
          [input.companyId, null, circleId, JSON.stringify({ tensionId: id, title, type: tensionType ?? "operational" })],
        );

        // Trigger A: governance tension → auto-create 3-of-3 async approval
        let approvalId: string | undefined;
        if (tensionType === "governance") {
          const approvalResult = await createGovernanceApproval({
            companyId: input.companyId,
            tensionId: id,
            title,
            description: description ?? null,
            requestedByAgentId: null,
          });
          if (approvalResult) {
            approvalId = approvalResult.approvalId;
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'governance-approval-created', $3)`,
              [input.companyId, circleId, JSON.stringify({ tensionId: id, approvalId: approvalResult.approvalId })],
            );
          }
        }

        return {
          status: 201,
          body: {
            tensionId: id,
            title,
            type: tensionType ?? "operational",
            status: "open",
            ...(approvalId ? { approvalId, approvalStatus: "pending" } : {}),
          },
        };
      }

      case API_ROUTES.updateTension: {
        const tensionId = input.params.tensionId as string;
        const { status, resolution } = input.body as { status: string; resolution?: string; companyId: string };
        const validStatuses = ["open", "processing", "resolved", "rejected"];
        if (!validStatuses.includes(status)) return { status: 400, body: { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` } };
        const resolvedAt = status === "resolved" || status === "rejected" ? "NOW()" : "NULL";
        await dbCtx!.execute(
          `UPDATE ${tbl("tensions")} SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2`,
          [status, tensionId],
        );
        if (resolution) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) SELECT $1, circle_id, 'tension-resolved', $3::jsonb FROM ${tbl("tensions")} WHERE id = $2`,
            [input.companyId, tensionId, JSON.stringify({ tensionId, status, resolution })],
          );
        }
        return { status: 200, body: { tensionId, status } };
      }

      case API_ROUTES.getAuditLog: {
        const circleId = input.params.circleId as string;
        const logs = await dbCtx!.query(
          `SELECT al.*, a.name as agent_name FROM ${tbl("audit_log")} al LEFT JOIN public.agents a ON a.id = al.agent_id WHERE al.circle_id = $1 ORDER BY al.created_at DESC LIMIT 200`,
          [circleId],
        );
        return { status: 200, body: logs };
      }

      case API_ROUTES.forwardTension: {
        const circleId = input.params.circleId as string;
        const { tensionId, context } = input.body as { tensionId: string; context: string; companyId: string };
        const tensions = await dbCtx!.query<Tension>(
          `SELECT * FROM ${tbl("tensions")} WHERE id = $1 AND circle_id = $2`,
          [tensionId, circleId],
        );
        if (tensions.length === 0) return { status: 404, body: { error: "Tension not found in this circle" } };
        const sourceTension = tensions[0];
        const circle = await dbCtx!.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        if (!circle[0]?.parent_circle_id) return { status: 400, body: { error: "Circle has no parent circle to forward to" } };
        const forwardedId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [forwardedId, circle[0].parent_circle_id, sourceTension.source_agent_id, `[Forwarded] ${sourceTension.title}`, `${context}\n\n---\nOriginal tension from ${circle[0].name}: ${sourceTension.description ?? ""}`, sourceTension.tension_type],
        );
        await dbCtx!.execute(
          `UPDATE ${tbl("tensions")} SET status = 'processing' WHERE id = $1`,
          [tensionId],
        );
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-forwarded', $4)`,
          [input.companyId, sourceTension.source_agent_id, circleId, JSON.stringify({ originalTensionId: tensionId, forwardedTensionId: forwardedId, targetCircleId: circle[0].parent_circle_id, context })],
        );
        return { status: 201, body: { forwardedTensionId: forwardedId, targetCircleId: circle[0].parent_circle_id, originalTensionId: tensionId, status: "forwarded" } };
      }

      case API_ROUTES.recordDecision: {
        const circleId = input.params.circleId as string;
        const { agentId, roleId, decision, context } = input.body as {
          agentId?: string; roleId?: string; decision: string; context?: string; companyId: string;
        };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (id, company_id, agent_id, role_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, $4, $5, 'decision', $6)`,
          [id, input.companyId, agentId ?? null, roleId ?? null, circleId, JSON.stringify({ decision, context })],
        );
        return { status: 201, body: { id, actionType: "decision", decision } };
      }

      case API_ROUTES.listPolicies: {
        const circleId = input.params.circleId as string;
        const policies = await dbCtx!.query(
          `SELECT * FROM ${tbl("policies")} WHERE circle_id = $1 ORDER BY created_at DESC`,
          [circleId],
        );
        return { status: 200, body: policies };
      }

      case API_ROUTES.createPolicy: {
        const circleId = input.params.circleId as string;
        const { title, description, domain } = input.body as { title: string; description: string; domain?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("policies")} (id, circle_id, title, description, domain) VALUES ($1, $2, $3, $4, $5)`,
          [id, circleId, title, description, domain ?? null],
        );
        return { status: 201, body: { id, circleId, title, description, domain } };
      }

      case API_ROUTES.updatePolicy: {
        const policyId = input.params.policyId as string;
        const { title, description, domain } = input.body as { title?: string; description?: string; domain?: string; companyId: string };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title); }
        if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
        if (domain !== undefined) { sets.push(`domain = $${idx++}`); vals.push(domain); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        sets.push(`updated_at = NOW()`);
        vals.push(policyId);
        await dbCtx!.execute(`UPDATE ${tbl("policies")} SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
        return { status: 200, body: { policyId, updated: true } };
      }

      case API_ROUTES.deletePolicy: {
        const policyId = input.params.policyId as string;
        await dbCtx!.execute(`DELETE FROM ${tbl("policies")} WHERE id = $1`, [policyId]);
        return { status: 200, body: { deleted: policyId } };
      }

      case API_ROUTES.listChecklists: {
        const circleId = input.params.circleId as string;
        const checklists = await dbCtx!.query(
          `SELECT cl.*, r.name as role_name FROM ${tbl("checklists")} cl LEFT JOIN ${tbl("roles")} r ON r.id = cl.role_id WHERE cl.circle_id = $1 ORDER BY cl.created_at`,
          [circleId],
        );
        return { status: 200, body: checklists };
      }

      case API_ROUTES.createChecklist: {
        const circleId = input.params.circleId as string;
        const { itemText, roleId, frequency } = input.body as { itemText: string; roleId?: string; frequency?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("checklists")} (id, circle_id, role_id, item_text, frequency) VALUES ($1, $2, $3, $4, $5)`,
          [id, circleId, roleId ?? null, itemText, frequency ?? "weekly"],
        );
        return { status: 201, body: { id, circleId, itemText, frequency: frequency ?? "weekly" } };
      }

      case API_ROUTES.respondChecklist: {
        const checklistId = input.params.checklistId as string;
        const { checked, periodDate, agentId } = input.body as { checked: boolean; periodDate: string; agentId?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("checklist_responses")} (id, checklist_id, agent_id, checked, period_date) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [id, checklistId, agentId ?? null, checked, periodDate],
        );
        return { status: 200, body: { checklistId, checked, periodDate } };
      }

      case API_ROUTES.listMetrics: {
        const circleId = input.params.circleId as string;
        const metrics = await dbCtx!.query(
          `SELECT m.*, r.name as role_name FROM ${tbl("metrics")} m LEFT JOIN ${tbl("roles")} r ON r.id = m.role_id WHERE m.circle_id = $1 ORDER BY m.created_at`,
          [circleId],
        );
        return { status: 200, body: metrics };
      }

      case API_ROUTES.createMetric: {
        const circleId = input.params.circleId as string;
        const { name, description, unit, roleId, frequency } = input.body as { name: string; description?: string; unit?: string; roleId?: string; frequency?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("metrics")} (id, circle_id, role_id, name, description, unit, frequency) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, circleId, roleId ?? null, name, description ?? null, unit ?? null, frequency ?? "weekly"],
        );
        return { status: 201, body: { id, circleId, name, unit, frequency: frequency ?? "weekly" } };
      }

      case API_ROUTES.reportMetric: {
        const metricId = input.params.metricId as string;
        const { value, periodDate, reportedBy } = input.body as { value: number; periodDate: string; reportedBy?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("metric_values")} (id, metric_id, value, period_date, reported_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, metricId, value, periodDate, reportedBy ?? null],
        );
        return { status: 201, body: { id, metricId, value, periodDate } };
      }

      case API_ROUTES.listStrategies: {
        const circleId = input.params.circleId as string;
        const strategies = await dbCtx!.query(
          `SELECT s.*, a.name as set_by_name FROM ${tbl("strategies")} s LEFT JOIN public.agents a ON a.id = s.set_by WHERE s.circle_id = $1 AND s.active = true ORDER BY s.created_at DESC`,
          [circleId],
        );
        return { status: 200, body: strategies };
      }

      case API_ROUTES.createStrategy: {
        const circleId = input.params.circleId as string;
        const { text, setBy } = input.body as { text: string; setBy?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("strategies")} (id, circle_id, text, set_by) VALUES ($1, $2, $3, $4)`,
          [id, circleId, text, setBy ?? null],
        );
        return { status: 201, body: { id, circleId, text } };
      }

      case API_ROUTES.updateStrategy: {
        const strategyId = input.params.strategyId as string;
        const { text, active } = input.body as { text?: string; active?: boolean; companyId: string };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (text !== undefined) { sets.push(`text = $${idx++}`); vals.push(text); }
        if (active !== undefined) { sets.push(`active = $${idx++}`); vals.push(active); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        vals.push(strategyId);
        await dbCtx!.execute(`UPDATE ${tbl("strategies")} SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
        return { status: 200, body: { strategyId, updated: true } };
      }

      case API_ROUTES.onboardAgent: {
        const circleId = input.params.circleId as string;
        const { agentId, roleName, rolePurpose, roleAccountabilities, roleDomains } = input.body as {
          agentId?: string; roleName: string; rolePurpose: string;
          roleAccountabilities?: string[]; roleDomains?: string[];
          companyId: string;
        };

        // Check domain conflicts before creating role + assignment
        if (agentId && roleDomains && roleDomains.length > 0) {
          const conflict = await checkDomainConflict(agentId, roleDomains, input.companyId);
          if (!conflict.ok) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
              [input.companyId, agentId, circleId, JSON.stringify({ violation: conflict.violation, roleName, domains: roleDomains, route: "onboardAgent" })],
            );
            return { status: 409, body: { error: conflict.violation } };
          }
        }

        const roleId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, 'custom', $5, $6)`,
          [roleId, circleId, roleName, rolePurpose, JSON.stringify(roleAccountabilities ?? []), JSON.stringify(roleDomains ?? [])],
        );
        if (agentId) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'agent-onboarded', $3)`,
          [input.companyId, circleId, JSON.stringify({ roleId, roleName, agentId, rolePurpose })],
        );
        return { status: 201, body: { roleId, roleName, circleId, agentId } };
      }

      case API_ROUTES.accountabilityScan: {
        // Nightly accountability scanner — evaluates pre-approved metrics against
        // agent accountabilities and files operational tensions for breaches.
        // Idempotency key: "<agentId>:<accountabilityName>:<YYYY-MM-DD>" prevents
        // duplicate tensions for the same (agent, accountability, day).
        const companyId = input.companyId;
        const rawScanDate = (input.body as { scanDate?: string } | undefined)?.scanDate;
        const scanDate = rawScanDate ?? new Date().toISOString().slice(0, 10);

        // Load all agents with accountabilities for this company
        const agents = await dbCtx!.query<{
          id: string;
          name: string;
          accountabilities: Array<{
            name: string;
            metric: string;
            target: number | string | boolean;
            alert_threshold: number | string | boolean;
            cadence: "hourly" | "daily" | "weekly" | "monthly";
            escalation_path?: string[];
          }>;
        }>(
          `SELECT id, name, accountabilities FROM public.agents WHERE company_id = $1 AND status != 'deleted'`,
          [companyId],
        );

        // Determine which cadences are "due now" for this scan.
        // Scanner runs daily — hourly and daily are always due; weekly on Monday; monthly on 1st.
        const dayOfWeek = new Date(scanDate + "T12:00:00Z").getDay(); // 0=Sun, use UTC noon to avoid TZ edge
        const dayOfMonth = parseInt(scanDate.slice(8, 10), 10);
        const dueCadences = new Set<string>(["hourly", "daily"]);
        if (dayOfWeek === 1) dueCadences.add("weekly");
        if (dayOfMonth === 1) dueCadences.add("monthly");

        // Find the GCC (root circle) for this company to use as fallback
        const gccRows = await dbCtx!.query<{ id: string }>(
          `SELECT id FROM ${tbl("circles")} WHERE company_id = $1 AND parent_circle_id IS NULL LIMIT 1`,
          [companyId],
        );
        const fallbackCircleId = gccRows[0]?.id;
        if (!fallbackCircleId) {
          return { status: 400, body: { error: "No root circle found for company" } };
        }

        // Helper: evaluate a pre-approved metric expression.
        // Returns number or boolean, or null if metric unknown.
        const evaluateMetric = async (
          agentId: string,
          metric: string,
        ): Promise<number | boolean | null> => {
          const m = metric.trim().toLowerCase();

          // "count of engineering issues marked done this week"
          if (m === "count of engineering issues marked done this week") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "average hours from pr opened to first review"
          if (m === "average hours from pr opened to first review") {
            // Proxy: avg hours issues in_review, updated within 7d
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - created_at))/3600, 0)::float as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_review' AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "count of backlog issues triaged and prioritized this week"
          if (m === "count of backlog issues triaged and prioritized this week") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status != 'backlog' AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "days since last roadmap update"
          if (m === "days since last roadmap update") {
            const rows = await dbCtx!.query<{ days: number | null }>(
              `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))/86400 as days FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2`,
              [companyId, agentId],
            );
            return rows[0]?.days ?? 9999;
          }

          // "count of coordination issues resolved or escalated this week"
          if (m === "count of coordination issues resolved or escalated this week") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status IN ('done','cancelled') AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "count of unassigned backlog issues older than 24h"
          if (m === "count of unassigned backlog issues older than 24h") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id IS NULL AND status = 'backlog' AND created_at < NOW() - INTERVAL '24 hours'`,
              [companyId],
            );
            return rows[0]?.count ?? 0;
          }

          // "days since last strategy heuristic update"
          if (m === "days since last strategy heuristic update") {
            const rows = await dbCtx!.query<{ days: number | null }>(
              `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(s.created_at)))/86400 as days FROM ${tbl("strategies")} s JOIN ${tbl("circles")} c ON c.id = s.circle_id WHERE c.company_id = $1`,
              [companyId],
            );
            return rows[0]?.days ?? 9999;
          }

          // "count of strategy documents published this month"
          if (m === "count of strategy documents published this month") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM ${tbl("strategies")} s JOIN ${tbl("circles")} c ON c.id = s.circle_id WHERE c.company_id = $1 AND s.created_at >= date_trunc('month', NOW())`,
              [companyId],
            );
            return rows[0]?.count ?? 0;
          }

          // "ratio of correctly routed issues to total routed issues"
          if (m === "ratio of correctly routed issues to total routed issues") {
            const rows = await dbCtx!.query<{ ratio: number | null }>(
              `SELECT CASE WHEN COUNT(*) = 0 THEN 1.0 ELSE COUNT(*) FILTER (WHERE status != 'backlog')::float / COUNT(*) END as ratio FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.ratio ?? 1.0;
          }

          // "ratio of passing regression tests to total regression tests" — static 1.0 (no test infra tracked in DB)
          if (m === "ratio of passing regression tests to total regression tests") {
            return 1.0; // assume passing unless external data shows otherwise
          }

          // "average hours from build ready to qa sign-off"
          if (m === "average hours from build ready to qa sign-off") {
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - created_at))/3600, 0)::float as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_review' AND updated_at >= NOW() - INTERVAL '30 days'`,
              [companyId, agentId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "average hours from tension raised to governance proposal filed"
          if (m === "average hours from tension raised to governance proposal filed") {
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - created_at))/3600, 0)::float as avg_hours FROM ${tbl("tensions")} WHERE circle_id IN (SELECT id FROM ${tbl("circles")} WHERE company_id = $1) AND status = 'open' AND created_at >= NOW() - INTERVAL '30 days'`,
              [companyId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "count of workflow automation scripts deployed this month"
          if (m === "count of workflow automation scripts deployed this month") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= date_trunc('month', NOW())`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "average hours from message received to response"
          if (m === "average hours from message received to response") {
            // Proxy: avg hours issues assigned to agent that moved from todo→in_progress within 24h
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - updated_at))/3600, 0)::float as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_progress' AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "agent is actively assigned to issues this month"
          if (m === "agent is actively assigned to issues this month") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND (status = 'in_progress' OR (status = 'done' AND completed_at >= date_trunc('month', NOW())))`,
              [companyId, agentId],
            );
            return (rows[0]?.count ?? 0) > 0;
          }

          // Machine-readable legacy formats (backward compat)
          if (/^count\(issues where assignee=AGENT and status=done and completedAt>=now-7d\)$/i.test(metric)) {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // boolean(true/false) literal
          const boolMatch = metric.match(/^boolean\((true|false)\)$/i);
          if (boolMatch) return boolMatch[1].toLowerCase() === "true";

          // Unknown metric — skip (no arbitrary SQL execution)
          console.warn(`[holacracy:scan] Unknown metric pattern, skipping: "${metric}"`);
          return null;
        };

        // Helper: check if metric value breaches threshold
        const breaches = (
          value: number | boolean,
          threshold: number | string | boolean,
          metric: string,
        ): boolean => {
          if (typeof value === "boolean") {
            // breach if value !== expected (threshold is the expected value)
            return value !== threshold;
          }
          const numThreshold = threshold as number;
          // "days since" and count-exceeds metrics: breach when value >= threshold
          // e.g. unrouted_backlog_count > 10, days_since > 60
          const isExceedsMetric =
            /^days since/.test(metric) ||
            /^count of unassigned/.test(metric) ||
            /^ratio/.test(metric) ||
            /^average hours/.test(metric);
          if (isExceedsMetric) {
            return value >= numThreshold;
          }
          // Count/rate metrics where higher is better: breach when value <= threshold
          // e.g. issues_completed_weekly <= 9999 (absurdly high threshold = always breach)
          return value <= numThreshold;
        };

        const tensionsRaised: Array<{ agentId: string; accountability: string; tensionId: string }> = [];
        const tensionsSkipped: Array<{ agentId: string; accountability: string; reason: string }> = [];

        for (const agent of agents) {
          const accs = Array.isArray(agent.accountabilities) ? agent.accountabilities : [];

          for (const acc of accs) {
            if (!dueCadences.has(acc.cadence)) {
              continue; // not due today
            }

            const idempotencyKey = `scan:${agent.id}:${acc.name}:${scanDate}`;

            // Dedup check — skip if tension already filed today
            const existing = await dbCtx!.query<{ id: string }>(
              `SELECT id FROM ${tbl("tensions")} WHERE idempotency_key = $1 LIMIT 1`,
              [idempotencyKey],
            );
            if (existing.length > 0) {
              tensionsSkipped.push({ agentId: agent.id, accountability: acc.name, reason: "duplicate" });
              continue;
            }

            // Evaluate metric
            let metricValue: number | boolean | null = null;
            try {
              metricValue = await evaluateMetric(agent.id, acc.metric);
            } catch (err) {
              console.error(`[holacracy:scan] metric eval error for ${agent.name}/${acc.name}:`, err);
              tensionsSkipped.push({ agentId: agent.id, accountability: acc.name, reason: "metric_error" });
              continue;
            }

            if (metricValue === null) {
              tensionsSkipped.push({ agentId: agent.id, accountability: acc.name, reason: "unknown_metric" });
              continue;
            }

            if (!breaches(metricValue, acc.alert_threshold, acc.metric)) {
              continue; // within threshold, no tension
            }

            // Find this agent's circle (first role_assignment → circle)
            const circleRows = await dbCtx!.query<{ circle_id: string }>(
              `SELECT r.circle_id FROM ${tbl("role_assignments")} ra JOIN ${tbl("roles")} r ON r.id = ra.role_id WHERE ra.agent_id = $1 LIMIT 1`,
              [agent.id],
            );
            const circleId = circleRows[0]?.circle_id ?? fallbackCircleId;

            // Determine assignee (escalation_path[0] || agent itself)
            const escalateTo = acc.escalation_path?.[0] ?? agent.id;

            const tensionId = randomUUID();
            const title = `[Scanner] ${agent.name} breached ${acc.name}: ${metricValue} vs threshold ${acc.alert_threshold}`;
            const description = JSON.stringify({
              agent_id: agent.id,
              accountability_name: acc.name,
              metric_expression: acc.metric,
              metric_value: metricValue,
              alert_threshold: acc.alert_threshold,
              cadence: acc.cadence,
              observed_at: new Date().toISOString(),
              scan_date: scanDate,
              escalate_to: escalateTo,
            });

            await dbCtx!.execute(
              `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type, idempotency_key) VALUES ($1, $2, $3, $4, $5, 'operational', $6)`,
              [tensionId, circleId, agent.id, title, description, idempotencyKey],
            );

            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
              [
                companyId,
                agent.id,
                circleId,
                JSON.stringify({ tensionId, source: "accountability-scanner", accountability: acc.name, scanDate }),
              ],
            );

            // Also write to GCC so company-level audit log surfaces scanner activity
            if (circleId !== fallbackCircleId) {
              await dbCtx!.execute(
                `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
                [
                  companyId,
                  agent.id,
                  fallbackCircleId,
                  JSON.stringify({ tensionId, source: "accountability-scanner", accountability: acc.name, scanDate, subCircleId: circleId }),
                ],
              );
            }

            tensionsRaised.push({ agentId: agent.id, accountability: acc.name, tensionId });
          }
        }

        return {
          status: 200,
          body: {
            scanDate,
            agentsScanned: agents.length,
            tensionsRaised: tensionsRaised.length,
            tensionsSkipped: tensionsSkipped.length,
            raised: tensionsRaised,
            skipped: tensionsSkipped,
          },
        };
      }

      default:
        return { status: 404, body: { error: "Unknown route" } };
    }
    } catch (err) {
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  },

});

runWorker(plugin, import.meta.url);

export default plugin;
