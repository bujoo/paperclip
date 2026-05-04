import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTES, EXPORT_NAMES, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
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
    {
      routeKey: API_ROUTES.listCircles,
      method: "GET",
      path: "/circles",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", param: "companyId" },
    },
    {
      routeKey: API_ROUTES.getCircle,
      method: "GET",
      path: "/circles/:circleId",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "pluginState", stateKey: "circle", param: "circleId" },
    },
    {
      routeKey: API_ROUTES.createCircle,
      method: "POST",
      path: "/circles",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", param: "companyId" },
    },
    {
      routeKey: API_ROUTES.listRoles,
      method: "GET",
      path: "/circles/:circleId/roles",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "pluginState", stateKey: "circle", param: "circleId" },
    },
    {
      routeKey: API_ROUTES.assignRole,
      method: "POST",
      path: "/circles/:circleId/roles",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "pluginState", stateKey: "circle", param: "circleId" },
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.getCircle,
      description: "Get a Holacracy circle's structure including its purpose, roles, sub-circles, and policies",
      inputSchema: {
        type: "object",
        properties: {
          circleId: { type: "string", description: "Circle ID to query" },
        },
        required: ["circleId"],
      },
    },
    {
      name: TOOL_NAMES.getRole,
      description: "Get a Holacracy role's details including purpose, accountabilities, domains, and who fills it",
      inputSchema: {
        type: "object",
        properties: {
          roleId: { type: "string", description: "Role ID to query" },
        },
        required: ["roleId"],
      },
    },
    {
      name: TOOL_NAMES.listTensions,
      description: "List open tensions in a Holacracy circle, optionally filtered by type (operational or governance)",
      inputSchema: {
        type: "object",
        properties: {
          circleId: { type: "string", description: "Circle ID to query tensions for" },
          type: { type: "string", enum: ["operational", "governance", "all"], description: "Filter by tension type" },
        },
        required: ["circleId"],
      },
    },
    {
      name: TOOL_NAMES.raiseTension,
      description: "Raise a tension in a Holacracy circle. The tension will be triaged in the next tactical or governance meeting.",
      inputSchema: {
        type: "object",
        properties: {
          circleId: { type: "string", description: "Circle where the tension exists" },
          title: { type: "string", description: "Brief title for the tension (1-2 words)" },
          description: { type: "string", description: "What is the gap between current reality and what could be?" },
          type: { type: "string", enum: ["operational", "governance"], description: "Operational = tactical meeting, governance = governance meeting" },
        },
        required: ["circleId", "title", "description", "type"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Circles",
        exportName: EXPORT_NAMES.page,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Circles",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "detailTab",
        id: SLOT_IDS.agentTab,
        displayName: "Role",
        exportName: EXPORT_NAMES.agentTab,
        entityTypes: ["agent"],
      },
      {
        type: "detailTab",
        id: SLOT_IDS.projectTab,
        displayName: "Circle",
        exportName: EXPORT_NAMES.projectTab,
        entityTypes: ["project"],
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Circle Health",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Holacracy",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
