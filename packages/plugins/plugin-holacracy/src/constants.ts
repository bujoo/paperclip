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
  checkAuthority: "holacracy-check-authority",
  logAction: "holacracy-log-action",
  forwardTension: "holacracy-forward-tension",
  listPolicies: "holacracy-list-policies",
  setStrategy: "holacracy-set-strategy",
  reportChecklist: "holacracy-report-checklist",
  reportMetric: "holacracy-report-metric",
  onboardAgent: "holacracy-onboard-agent",
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
  listTensions: "list-tensions",
  raiseTension: "raise-tension",
  updateTension: "update-tension",
  getAuditLog: "get-audit-log",
  recordDecision: "record-decision",
  forwardTension: "forward-tension",
  listPolicies: "list-policies",
  createPolicy: "create-policy",
  updatePolicy: "update-policy",
  deletePolicy: "delete-policy",
  listChecklists: "list-checklists",
  createChecklist: "create-checklist",
  respondChecklist: "respond-checklist",
  listMetrics: "list-metrics",
  createMetric: "create-metric",
  reportMetric: "report-metric",
  listStrategies: "list-strategies",
  createStrategy: "create-strategy",
  updateStrategy: "update-strategy",
  onboardAgent: "onboard-agent",
} as const;
