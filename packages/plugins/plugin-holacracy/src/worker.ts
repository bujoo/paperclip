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

      default:
        return { status: 404, body: { error: "Unknown route" } };
    }
  },

});

runWorker(plugin, import.meta.url);

export default plugin;
