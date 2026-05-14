export const API_ROUTES = {
  listServers: "list-servers",
  createServer: "create-server",
  updateServer: "update-server",
  deleteServer: "delete-server",
  syncServers: "sync-servers",
  listAgentMcps: "list-agent-mcps",
  assignAgentMcp: "assign-agent-mcp",
  removeAgentMcp: "remove-agent-mcp",
} as const;

export const TOOL_NAMES = {
  resolveConfig: "mcp-resolve-config",
  listCatalog: "mcp-list-catalog",
} as const;
