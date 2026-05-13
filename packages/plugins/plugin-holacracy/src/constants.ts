export const PLUGIN_ID = "paperclipai.plugin-holacracy";
export const PLUGIN_VERSION = "0.1.0";

export const ROLE_TYPES = {
  circleLead: "circle_lead",
  facilitator: "facilitator",
  secretary: "secretary",
  circleRep: "circle_rep",
  custom: "custom",
} as const;

export type RoleType = (typeof ROLE_TYPES)[keyof typeof ROLE_TYPES];

export const CIRCLE_COLORS: Record<string, string> = {
  strategy: "#3b82f6",
  product: "#22c55e",
  growth: "#f59e0b",
  content: "#a855f7",
  default: "#6b7280",
};

export const SLOT_IDS = {
  page: "holacracy-circles",
  sidebar: "holacracy-sidebar",
  agentTab: "holacracy-agent-role",
  projectTab: "holacracy-circle-detail",
  dashboardWidget: "holacracy-health",
  settingsPage: "holacracy-settings",
} as const;

export const EXPORT_NAMES = {
  page: "CircleNavigator",
  sidebar: "HolacracySidebar",
  agentTab: "AgentRoleTab",
  projectTab: "CircleDetailTab",
  dashboardWidget: "CircleHealthWidget",
  settingsPage: "HolacracySettings",
} as const;

export const TOOL_NAMES = {
  getCircle: "holacracy-get-circle",
  getRole: "holacracy-get-role",
  listTensions: "holacracy-list-tensions",
  raiseTension: "holacracy-raise-tension",
} as const;

export const API_ROUTES = {
  listCircles: "list-circles",
  getCircle: "get-circle",
  createCircle: "create-circle",
  listRoles: "list-roles",
  assignRole: "assign-role",
  updateRole: "update-role",
  updateCircle: "update-circle",
  updateRoleAssignment: "update-role-assignment",
  deleteCircle: "delete-circle",
} as const;
