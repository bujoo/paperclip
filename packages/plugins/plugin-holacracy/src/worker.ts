import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { API_ROUTES, ROLE_TYPES, TOOL_NAMES, type RoleType } from "./constants.js";

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

const plugin = definePlugin({
  async setup(ctx) {
    dbCtx = ctx.db;

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
        return { content: JSON.stringify({ tensionId: id, status: "open", message: `Tension raised: "${title}" (${tensionType})` }) };
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
  },

  async onApiRequest(input: PluginApiRequestInput) {
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
          `SELECT al.*, a.name as agent_name FROM ${tbl("audit_log")} al LEFT JOIN public.agents a ON a.id = al.agent_id WHERE al.circle_id = $1 ORDER BY al.created_at DESC LIMIT 50`,
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

      default:
        return { status: 404, body: { error: "Unknown route" } };
    }
  },

});

runWorker(plugin, import.meta.url);

export default plugin;
