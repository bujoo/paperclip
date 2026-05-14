import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-mcp-manager",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "MCP Manager",
  description:
    "Manage Model Context Protocol servers for your agents. " +
    "Catalog MCP servers, assign them per-agent, and resolve configurations at runtime.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "projects.read",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
    "agent.tools.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "mcp_manager",
    migrationsDir: "migrations",
    coreReadTables: ["agents", "projects"],
  },
  apiRoutes: [
    { routeKey: "list-servers", method: "GET", path: "/servers", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "create-server", method: "POST", path: "/servers", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "update-server", method: "PATCH", path: "/servers/:serverId", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "delete-server", method: "DELETE", path: "/servers/:serverId", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "sync-servers", method: "POST", path: "/servers/sync", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "list-agent-mcps", method: "GET", path: "/agents/:agentId/mcps", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "assign-agent-mcp", method: "POST", path: "/agents/:agentId/mcps", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "remove-agent-mcp", method: "DELETE", path: "/agents/:agentId/mcps/:assignmentId", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
  ],
  tools: [
    {
      name: "mcp-resolve-config",
      displayName: "Resolve MCP Config",
      description: "Resolve the MCP server configuration for a specific agent. Returns a JSON object suitable for .mcp.json with all assigned MCP servers.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The agent ID to resolve MCP config for" },
          companyId: { type: "string", description: "The company ID" },
        },
        required: ["agentId", "companyId"],
      },
    },
    {
      name: "mcp-list-catalog",
      displayName: "List MCP Catalog",
      description: "List all available MCP servers in the company catalog.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", description: "The company ID" },
        },
        required: ["companyId"],
      },
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "mcp-manager-page", displayName: "MCP Servers", exportName: "McpManagerPage" },
      { type: "sidebar", id: "mcp-manager-sidebar", displayName: "MCP Servers", exportName: "McpSidebar" },
      { type: "detailTab", id: "mcp-agent-tab", displayName: "MCPs", exportName: "AgentMcpTab", entityTypes: ["agent"] },
    ],
  },
};

export default manifest;
