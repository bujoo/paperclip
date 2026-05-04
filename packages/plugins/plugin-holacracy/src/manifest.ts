import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-holacracy",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Holacracy",
  description:
    "Self-governance for AI agents: circles, roles, tensions, governance & tactical meetings. " +
    "Replaces top-down hierarchy with distributed authority using the Holacracy v5 framework.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "issue.relations.write",
    "agents.read",
    "goals.read",
    "goals.create",
    "goals.update",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "api.routes.register",
    "agent.tools.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "holacracy",
    migrationsDir: "migrations",
    coreReadTables: ["issues", "agents", "projects", "goals"],
  },
  apiRoutes: [
    { routeKey: "list-circles", method: "GET", path: "/circles", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "get-circle", method: "GET", path: "/circles/:circleId", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "create-circle", method: "POST", path: "/circles", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "list-roles", method: "GET", path: "/circles/:circleId/roles", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "assign-role", method: "POST", path: "/circles/:circleId/roles", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "delete-circle", method: "DELETE", path: "/circles/:circleId", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
  ],
  tools: [
    { name: "holacracy-get-circle", displayName: "Get Holacracy Circle", description: "Get a circle's structure including purpose, roles, sub-circles, and policies", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
    { name: "holacracy-get-role", displayName: "Get Holacracy Role", description: "Get a role's details including purpose, accountabilities, domains, and who fills it", parametersSchema: { type: "object", properties: { roleId: { type: "string" } }, required: ["roleId"] } },
    { name: "holacracy-list-tensions", displayName: "List Circle Tensions", description: "List open tensions in a circle, optionally filtered by type", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, type: { type: "string", enum: ["operational", "governance", "all"] } }, required: ["circleId"] } },
    { name: "holacracy-raise-tension", displayName: "Raise Tension", description: "Raise a tension in a circle for processing in the next meeting", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, type: { type: "string", enum: ["operational", "governance"] } }, required: ["circleId", "title", "description", "type"] } },
  ],
  ui: {
    slots: [
      { type: "page", id: "holacracy-circles", displayName: "Circles", exportName: "CircleNavigator" },
      { type: "sidebar", id: "holacracy-sidebar", displayName: "Circles", exportName: "HolacracySidebar" },
      { type: "detailTab", id: "holacracy-agent-role", displayName: "Role", exportName: "AgentRoleTab", entityTypes: ["agent"] },
      { type: "detailTab", id: "holacracy-circle-detail", displayName: "Circle", exportName: "CircleDetailTab", entityTypes: ["project"] },
      { type: "dashboardWidget", id: "holacracy-health", displayName: "Circle Health", exportName: "CircleHealthWidget" },
      { type: "settingsPage", id: "holacracy-settings", displayName: "Holacracy", exportName: "HolacracySettings" },
    ],
  },
};

export default manifest;
