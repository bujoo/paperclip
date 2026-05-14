import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { API_ROUTES, TOOL_NAMES } from "./constants.js";

let db: PluginContext["db"];

function tbl(table: string) {
  return `${db.namespace}.${table}`;
}

interface DiscoveredServer {
  name: string;
  transportType: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  transportUrl: string | null;
  configPath: string;
}

function discoverClaudeMcpServers(): DiscoveredServer[] {
  const discovered: DiscoveredServer[] = [];
  const claudeDir = path.join(os.homedir(), ".claude");
  const configPaths = [
    path.join(claudeDir, "mcp.json"),
    path.join(claudeDir, ".mcp.json"),
  ];

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const servers = parsed?.mcpServers;
      if (!servers || typeof servers !== "object") continue;

      for (const [name, config] of Object.entries(servers)) {
        if (discovered.some((d) => d.name === name)) continue;
        const cfg = config as Record<string, unknown>;
        const typeField = (cfg.type as string) || "";
        const hasUrl = typeof cfg.url === "string";
        const hasCommand = typeof cfg.command === "string";

        let transportType: "stdio" | "http" | "sse" = "stdio";
        if (typeField === "sse") transportType = "sse";
        else if (typeField === "http" || typeField === "url" || hasUrl) transportType = "http";

        discovered.push({
          name,
          transportType,
          command: hasCommand ? cfg.command as string : null,
          args: Array.isArray(cfg.args) ? cfg.args as string[] : [],
          env: (typeof cfg.env === "object" && cfg.env !== null && !Array.isArray(cfg.env))
            ? cfg.env as Record<string, string> : {},
          transportUrl: hasUrl ? cfg.url as string : null,
          configPath,
        });
      }
    } catch {
      // ignore parse errors
    }
  }

  return discovered;
}

const plugin = definePlugin({
  async setup(ctx) {
    db = ctx.db;

    ctx.data.register("mcp-servers-list", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      return db.query(`SELECT * FROM ${tbl("mcp_servers")} WHERE company_id = $1 ORDER BY name`, [companyId]);
    });

    ctx.data.register("agent-mcp-assignments", async (params) => {
      const agentId = params.agentId as string;
      if (!agentId) return [];
      return db.query(
        `SELECT a.*, s.name, s.display_name, s.transport_type, s.command, s.args, s.transport_url, s.description as server_description
         FROM ${tbl("agent_mcp_assignments")} a
         JOIN ${tbl("mcp_servers")} s ON s.id = a.mcp_server_id
         WHERE a.agent_id = $1
         ORDER BY s.name`,
        [agentId],
      );
    });

    ctx.data.register("discovered-servers", async () => {
      return discoverClaudeMcpServers();
    });

    ctx.tools.register(
      TOOL_NAMES.resolveConfig,
      {
        displayName: "Resolve MCP Config",
        description: "Resolve MCP server configuration for an agent",
        parametersSchema: {
          type: "object",
          properties: { agentId: { type: "string" }, companyId: { type: "string" } },
          required: ["agentId", "companyId"],
        },
      },
      async (params) => {
        const { agentId, companyId } = params as { agentId: string; companyId: string };
        const config = await resolveAgentMcpConfig(agentId, companyId);
        return { content: JSON.stringify(config, null, 2), data: config };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listCatalog,
      {
        displayName: "List MCP Catalog",
        description: "List available MCP servers",
        parametersSchema: {
          type: "object",
          properties: { companyId: { type: "string" } },
          required: ["companyId"],
        },
      },
      async (params) => {
        const { companyId } = params as { companyId: string };
        const servers = await db.query(
          `SELECT id, name, display_name, description, transport_type, enabled
           FROM ${tbl("mcp_servers")} WHERE company_id = $1 AND scope = 'company' ORDER BY name`,
          [companyId],
        );
        return { content: JSON.stringify(servers, null, 2), data: servers };
      },
    );
  },

  async onApiRequest(input) {
    const { routeKey, params, query, body } = input;

    try {
      switch (routeKey) {
        case API_ROUTES.listServers: {
          const companyId = query.companyId as string;
          const rows = await db.query(
            `SELECT * FROM ${tbl("mcp_servers")} WHERE company_id = $1 ORDER BY name`,
            [companyId],
          );
          return { status: 200, body: rows };
        }

        case API_ROUTES.createServer: {
          const { companyId, name, displayName, description, command, args, env, transportType, transportUrl, source, scope, agentId } = body;
          if (!name || !transportType) {
            return { status: 400, body: { error: "Missing required fields: name, transportType" } };
          }
          if (transportType === "stdio" && !command) {
            return { status: 400, body: { error: "stdio transport requires a command" } };
          }
          const id = randomUUID();
          await db.execute(
            `INSERT INTO ${tbl("mcp_servers")}
             (id, company_id, name, display_name, description, command, args, env, transport_type, transport_url, source, scope, agent_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              id, companyId, name,
              displayName || null, description || null, command || null,
              JSON.stringify(args || []), JSON.stringify(env || {}),
              transportType, transportUrl || null,
              source || "manual",
              scope || "company", agentId || null,
            ],
          );
          const rows = await db.query(`SELECT * FROM ${tbl("mcp_servers")} WHERE id = $1`, [id]);
          return { status: 201, body: rows[0] };
        }

        case API_ROUTES.updateServer: {
          const serverId = params.serverId as string;
          const sets: string[] = [];
          const vals: unknown[] = [];
          let idx = 1;

          for (const [key, col] of [
            ["name", "name"], ["displayName", "display_name"], ["description", "description"],
            ["command", "command"], ["transportType", "transport_type"], ["transportUrl", "transport_url"],
          ] as const) {
            if (body[key] !== undefined) { sets.push(`${col} = $${idx++}`); vals.push(body[key]); }
          }
          if (body.args !== undefined) { sets.push(`args = $${idx++}`); vals.push(JSON.stringify(body.args)); }
          if (body.env !== undefined) { sets.push(`env = $${idx++}`); vals.push(JSON.stringify(body.env)); }
          if (body.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(body.enabled); }

          if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };

          sets.push(`updated_at = now()`);
          vals.push(serverId);

          await db.execute(
            `UPDATE ${tbl("mcp_servers")} SET ${sets.join(", ")} WHERE id = $${idx}`,
            vals,
          );
          const rows = await db.query(`SELECT * FROM ${tbl("mcp_servers")} WHERE id = $1`, [serverId]);
          if (!rows.length) return { status: 404, body: { error: "MCP server not found" } };
          return { status: 200, body: rows[0] };
        }

        case API_ROUTES.deleteServer: {
          const serverId = params.serverId as string;
          await db.execute(`DELETE FROM ${tbl("agent_mcp_assignments")} WHERE mcp_server_id = $1`, [serverId]);
          await db.execute(`DELETE FROM ${tbl("mcp_servers")} WHERE id = $1`, [serverId]);
          return { status: 200, body: { success: true } };
        }

        case API_ROUTES.syncServers: {
          const { companyId } = body;
          const discovered = discoverClaudeMcpServers();
          let imported = 0;

          for (const server of discovered) {
            const existing = await db.query(
              `SELECT id FROM ${tbl("mcp_servers")} WHERE company_id = $1 AND name = $2`,
              [companyId, server.name],
            );
            if (existing.length > 0) continue;

            const id = randomUUID();
            await db.execute(
              `INSERT INTO ${tbl("mcp_servers")}
               (id, company_id, name, command, args, env, transport_type, transport_url, source, scope)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'discovered', 'company')`,
              [
                id, companyId, server.name,
                server.command, JSON.stringify(server.args), JSON.stringify(server.env),
                server.transportType, server.transportUrl,
              ],
            );
            imported++;
          }

          return { status: 200, body: { imported, total: discovered.length } };
        }

        case API_ROUTES.listAgentMcps: {
          const agentId = params.agentId as string;
          const rows = await db.query(
            `SELECT a.*, s.name, s.display_name, s.transport_type, s.command, s.args, s.transport_url,
                    s.description as server_description, s.env
             FROM ${tbl("agent_mcp_assignments")} a
             JOIN ${tbl("mcp_servers")} s ON s.id = a.mcp_server_id
             WHERE a.agent_id = $1
             ORDER BY s.name`,
            [agentId],
          );
          return { status: 200, body: rows };
        }

        case API_ROUTES.assignAgentMcp: {
          const agentId = params.agentId as string;
          const { mcpServerId } = body;
          if (!mcpServerId) return { status: 400, body: { error: "Missing required field: mcpServerId" } };

          const existing = await db.query(
            `SELECT id FROM ${tbl("agent_mcp_assignments")} WHERE agent_id = $1 AND mcp_server_id = $2`,
            [agentId, mcpServerId],
          );
          if (existing.length > 0) return { status: 200, body: existing[0] };

          const id = randomUUID();
          await db.execute(
            `INSERT INTO ${tbl("agent_mcp_assignments")} (id, agent_id, mcp_server_id) VALUES ($1, $2, $3)`,
            [id, agentId, mcpServerId],
          );
          const rows = await db.query(`SELECT * FROM ${tbl("agent_mcp_assignments")} WHERE id = $1`, [id]);
          return { status: 201, body: rows[0] };
        }

        case API_ROUTES.removeAgentMcp: {
          const assignmentId = params.assignmentId as string;
          await db.execute(`DELETE FROM ${tbl("agent_mcp_assignments")} WHERE id = $1`, [assignmentId]);
          return { status: 200, body: { success: true } };
        }

        default:
          return { status: 404, body: { error: `Unknown route: ${routeKey}` } };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 500, body: { error: message } };
    }
  },

  async onHealth() {
    return { status: "ok", message: "MCP Manager running" };
  },
});

async function resolveAgentMcpConfig(agentId: string, companyId: string) {
  const rows = await db.query(
    `SELECT s.name, s.command, s.args, s.env, s.transport_type, s.transport_url
     FROM ${tbl("agent_mcp_assignments")} a
     JOIN ${tbl("mcp_servers")} s ON s.id = a.mcp_server_id
     WHERE a.agent_id = $1 AND a.enabled = true AND s.enabled = true AND s.company_id = $2`,
    [agentId, companyId],
  );

  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (row.transport_type === "http" || row.transport_type === "sse") {
      mcpServers[row.name] = { type: row.transport_type, url: row.transport_url || "" };
    } else {
      mcpServers[row.name] = {
        command: row.command,
        args: typeof row.args === "string" ? JSON.parse(row.args) : row.args,
        env: typeof row.env === "string" ? JSON.parse(row.env) : row.env,
      };
    }
  }
  return { mcpServers };
}

export default plugin;
runWorker(plugin, import.meta.url);
