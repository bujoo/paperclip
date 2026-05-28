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

export const GOVERNANCE_APPROVERS = {
  strategist: "aec05dae-7af7-4323-a21e-00040fbc766a",
  productManager: "9adc6c20-de6e-4f0a-83de-ebe8a380f5d0",
  devLead: "e1f66962-dc3c-4a8e-9875-de1a1dee2839",
} as const;

export const GOVERNANCE_APPROVAL_TIMEOUT_HOURS = 24;

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

/**
 * Default domain conflict pairs (global, company_id = all-zero UUID).
 * Each entry: domain X conflicts with each entry in `conflicts` array.
 * Conflict is symmetric (we register both directions on seed).
 *
 * Source: MYA-59 strategic verdict — Sales/Growth/Doc Lead overlap incident.
 */
export const DEFAULT_DOMAIN_REGISTRY: Array<{
  domain: string;
  description: string;
  conflicts: string[];
}> = [
  {
    domain: "sales",
    description: "Outbound revenue, deal-closing, customer acquisition",
    conflicts: ["growth", "documentation"],
  },
  {
    domain: "growth",
    description: "Top-of-funnel marketing, virality, organic acquisition",
    conflicts: ["sales", "documentation"],
  },
  {
    domain: "documentation",
    description: "Canonical product docs, knowledge base, ref material",
    conflicts: ["sales", "growth"],
  },
  // Engineering vs. governance separation
  {
    domain: "engineering",
    description: "Code authorship, system implementation",
    conflicts: ["governance"],
  },
  {
    domain: "governance",
    description: "Constitution, role definitions, policy authoring",
    conflicts: ["engineering"],
  },
];

export const GLOBAL_DOMAIN_REGISTRY_COMPANY_ID = "00000000-0000-0000-0000-000000000000";

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
  accountabilityScan: "accountability-scan",
} as const;
