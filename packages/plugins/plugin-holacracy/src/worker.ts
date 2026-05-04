import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { API_ROUTES, ROLE_TYPES, TOOL_NAMES, type RoleType } from "./constants.js";

interface Circle {
  id: string;
  company_id: string;
  project_id: string | null;
  parent_circle_id: string | null;
  name: string;
  purpose: string | null;
  domains: string[];
  policies: string[];
  color: string | null;
  created_at: string;
}

interface Role {
  id: string;
  circle_id: string;
  name: string;
  purpose: string | null;
  role_type: RoleType;
  domains: string[];
  accountabilities: string[];
}

interface RoleAssignment {
  id: string;
  role_id: string;
  agent_id: string;
  focus_ap: number;
}

interface Tension {
  id: string;
  circle_id: string;
  issue_id: string | null;
  source_agent_id: string | null;
  title: string;
  description: string | null;
  tension_type: string;
  status: string;
}

function t(ns: string, table: string) {
  return `${ns}.${table}`;
}

const CORE_ROLE_DEFINITIONS: Array<{ name: string; type: RoleType; purpose: string }> = [
  { name: "Circle Lead", type: ROLE_TYPES.circleLead, purpose: "Hold the circle's overall purpose and manage role assignments" },
  { name: "Facilitator", type: ROLE_TYPES.facilitator, purpose: "Facilitate governance and tactical meetings aligned with the Holacracy constitution" },
  { name: "Secretary", type: ROLE_TYPES.secretary, purpose: "Stabilize the circle's governance records and schedule required meetings" },
  { name: "Circle Rep", type: ROLE_TYPES.circleRep, purpose: "Represent the circle's needs and tensions in the parent circle" },
];

const plugin = definePlugin({
  async setup(ctx) {
    ctx.tools.register(TOOL_NAMES.getCircle, async (_input: ToolRunContext): Promise<ToolResult> => {
      const circleId = _input.params.circleId as string;
      const circles = await ctx.db.query<Circle>(
        `SELECT * FROM ${t(ctx.db.namespace, "circles")} WHERE id = $1`,
        [circleId],
      );
      if (circles.length === 0) return { content: [{ type: "text", text: "Circle not found" }], isError: true };

      const circle = circles[0];
      const roles = await ctx.db.query<Role & { agent_name?: string }>(
        `SELECT r.*, a.name as agent_name FROM ${t(ctx.db.namespace, "roles")} r
         LEFT JOIN ${t(ctx.db.namespace, "role_assignments")} ra ON ra.role_id = r.id
         LEFT JOIN public.agents a ON a.id = ra.agent_id
         WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
        [circleId],
      );
      const subCircles = await ctx.db.query<Circle>(
        `SELECT * FROM ${t(ctx.db.namespace, "circles")} WHERE parent_circle_id = $1`,
        [circleId],
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ circle, roles, subCircles }, null, 2),
        }],
      };
    });

    ctx.tools.register(TOOL_NAMES.getRole, async (_input: ToolRunContext): Promise<ToolResult> => {
      const roleId = _input.params.roleId as string;
      const roles = await ctx.db.query<Role>(
        `SELECT * FROM ${t(ctx.db.namespace, "roles")} WHERE id = $1`,
        [roleId],
      );
      if (roles.length === 0) return { content: [{ type: "text", text: "Role not found" }], isError: true };

      const assignments = await ctx.db.query<RoleAssignment & { agent_name: string }>(
        `SELECT ra.*, a.name as agent_name FROM ${t(ctx.db.namespace, "role_assignments")} ra
         JOIN public.agents a ON a.id = ra.agent_id
         WHERE ra.role_id = $1`,
        [roleId],
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ role: roles[0], filledBy: assignments }, null, 2),
        }],
      };
    });

    ctx.tools.register(TOOL_NAMES.listTensions, async (_input: ToolRunContext): Promise<ToolResult> => {
      const circleId = _input.params.circleId as string;
      const tensionType = (_input.params.type as string) || "all";

      const whereClause = tensionType === "all"
        ? "WHERE circle_id = $1 AND status = 'open'"
        : "WHERE circle_id = $1 AND status = 'open' AND tension_type = $2";
      const params = tensionType === "all" ? [circleId] : [circleId, tensionType];

      const tensions = await ctx.db.query<Tension>(
        `SELECT * FROM ${t(ctx.db.namespace, "tensions")} ${whereClause} ORDER BY created_at DESC`,
        params,
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ tensions, count: tensions.length }, null, 2),
        }],
      };
    });

    ctx.tools.register(TOOL_NAMES.raiseTension, async (_input: ToolRunContext): Promise<ToolResult> => {
      const { circleId, title, description, type: tensionType } = _input.params as {
        circleId: string;
        title: string;
        description: string;
        type: string;
      };

      const id = randomUUID();
      await ctx.db.query(
        `INSERT INTO ${t(ctx.db.namespace, "tensions")} (id, circle_id, source_agent_id, title, description, tension_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, circleId, _input.agentId ?? null, title, description, tensionType],
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ tensionId: id, status: "open", message: `Tension raised: "${title}" (${tensionType})` }),
        }],
      };
    });
  },

  async onApiRequest(input: PluginApiRequestInput, ctx: PluginContext) {
    const ns = ctx.db.namespace;

    switch (input.routeKey) {
      case API_ROUTES.listCircles: {
        const companyId = input.query.companyId as string;
        const circles = await ctx.db.query<Circle>(
          `SELECT * FROM ${t(ns, "circles")} WHERE company_id = $1 ORDER BY parent_circle_id NULLS FIRST, name`,
          [companyId],
        );
        return { status: 200, body: circles };
      }

      case API_ROUTES.getCircle: {
        const circleId = input.params.circleId as string;
        const circles = await ctx.db.query<Circle>(
          `SELECT * FROM ${t(ns, "circles")} WHERE id = $1`,
          [circleId],
        );
        if (circles.length === 0) return { status: 404, body: { error: "Circle not found" } };

        const roles = await ctx.db.query<Role & { agent_name?: string; agent_id?: string }>(
          `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${t(ns, "roles")} r
           LEFT JOIN ${t(ns, "role_assignments")} ra ON ra.role_id = r.id
           LEFT JOIN public.agents a ON a.id = ra.agent_id
           WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
          [circleId],
        );
        const subCircles = await ctx.db.query<Circle>(
          `SELECT * FROM ${t(ns, "circles")} WHERE parent_circle_id = $1`,
          [circleId],
        );
        const tensions = await ctx.db.query<Tension>(
          `SELECT * FROM ${t(ns, "tensions")} WHERE circle_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 10`,
          [circleId],
        );

        return { status: 200, body: { circle: circles[0], roles, subCircles, tensions } };
      }

      case API_ROUTES.createCircle: {
        const { companyId, name, purpose, parentCircleId, projectId, color } = input.body as {
          companyId: string;
          name: string;
          purpose?: string;
          parentCircleId?: string;
          projectId?: string;
          color?: string;
        };

        const id = randomUUID();
        await ctx.db.query(
          `INSERT INTO ${t(ns, "circles")} (id, company_id, name, purpose, parent_circle_id, project_id, color)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, companyId, name, purpose ?? null, parentCircleId ?? null, projectId ?? null, color ?? null],
        );

        for (const def of CORE_ROLE_DEFINITIONS) {
          await ctx.db.query(
            `INSERT INTO ${t(ns, "roles")} (id, circle_id, name, purpose, role_type)
             VALUES ($1, $2, $3, $4, $5)`,
            [randomUUID(), id, def.name, def.purpose, def.type],
          );
        }

        return { status: 201, body: { id, name, purpose, parentCircleId, coreRolesCreated: CORE_ROLE_DEFINITIONS.length } };
      }

      case API_ROUTES.listRoles: {
        const circleId = input.params.circleId as string;
        const roles = await ctx.db.query<Role & { agent_name?: string; agent_id?: string }>(
          `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${t(ns, "roles")} r
           LEFT JOIN ${t(ns, "role_assignments")} ra ON ra.role_id = r.id
           LEFT JOIN public.agents a ON a.id = ra.agent_id
           WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
          [circleId],
        );
        return { status: 200, body: roles };
      }

      case API_ROUTES.assignRole: {
        const circleId = input.params.circleId as string;
        const { roleName, roleType, purpose, accountabilities, domains, agentId } = input.body as {
          roleName: string;
          roleType?: RoleType;
          purpose?: string;
          accountabilities?: string[];
          domains?: string[];
          agentId?: string;
        };

        const roleId = randomUUID();
        await ctx.db.query(
          `INSERT INTO ${t(ns, "roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [roleId, circleId, roleName, purpose ?? null, roleType ?? "custom",
           JSON.stringify(accountabilities ?? []), JSON.stringify(domains ?? [])],
        );

        if (agentId) {
          await ctx.db.query(
            `INSERT INTO ${t(ns, "role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }

        return { status: 201, body: { roleId, roleName, circleId, agentId } };
      }

      default:
        return { status: 404, body: { error: "Unknown route" } };
    }
  },

  async onHealthCheck() {
    return { status: "healthy", details: {} };
  },
});

runWorker(plugin);

export default plugin;
