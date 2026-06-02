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
  listAgreements: "holacracy-list-agreements",
  proposeAgreement: "holacracy-propose-agreement",
  activateAgreement: "holacracy-activate-agreement",
  revokeAgreement: "holacracy-revoke-agreement",
  // IDM (Integrative Decision-Making) — canonical 6-phase async protocol
  idmPropose: "holacracy-idm-propose",
  idmQuestion: "holacracy-idm-question",
  idmReact: "holacracy-idm-react",
  idmAmend: "holacracy-idm-amend",
  idmObject: "holacracy-idm-object",
  idmValidateObjection: "holacracy-idm-validate-objection",
  idmIntegrate: "holacracy-idm-integrate",
  // Phase 2 — Cross-links, role-release, tactical, elections
  createCrossLink: "holacracy-create-cross-link",
  listCrossLinks: "holacracy-list-cross-links",
  dissolveCrossLink: "holacracy-dissolve-cross-link",
  releaseRole: "holacracy-release-role",
  acceptRelease: "holacracy-accept-release",
  completeHandoff: "holacracy-complete-handoff",
  runTacticalPulse: "holacracy-run-tactical-pulse",
  listTacticalRecords: "holacracy-list-tactical-records",
  requestFromRole: "holacracy-request-from-role",
  acceptCrossRoleRequest: "holacracy-accept-cross-role-request",
  declineCrossRoleRequest: "holacracy-decline-cross-role-request",
  requestElection: "holacracy-request-election",
  runElectionScoring: "holacracy-run-election-scoring",
  decideElection: "holacracy-decide-election",
  cancelElection: "holacracy-cancel-election",
  // Phase 1.13 — Speech tools (agent voice over A2A-MQTT)
  talkToAgent: "holacracy-talk-to-agent",
  replyOnTask: "holacracy-reply-on-task",
  broadcastToCircle: "holacracy-broadcast-to-circle",
  raiseTensionOnBus: "holacracy-raise-tension-on-bus",
  askSkill: "holacracy-ask-skill",
  // Phase 1.15d — repair tools
  askClarifyingQuestion: "holacracy-ask-clarifying-question",
  retractTurn: "holacracy-retract-turn",
  // Phase 1.15e — commit-to-support
  commitToConclusion: "holacracy-commit-to-conclusion",
  // Phase 1.15g — 1:1 primitive
  requestOneOnOne: "holacracy-request-one-on-one",
} as const;

// IDM phase enum + per-phase default deadline.
export const IDM_PHASES = {
  proposal: "proposal",
  clarifying: "clarifying",
  reactions: "reactions",
  amendOrClarify: "amend_or_clarify",
  objections: "objections",
  integration: "integration",
  adopted: "adopted",
  dropped: "dropped",
} as const;

export type IdmPhase = (typeof IDM_PHASES)[keyof typeof IDM_PHASES];

export const IDM_DEFAULT_PHASE_HOURS = 24;

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
  listWorkflows: "list-workflows",
  createWorkflow: "create-workflow",
  getWorkflow: "get-workflow",
  updateWorkflow: "update-workflow",
  deleteWorkflow: "delete-workflow",
  applyWorkflow: "apply-workflow",
  listCircleAgreements: "list-circle-agreements",
  createAgreement: "create-agreement",
  activateAgreement: "activate-agreement",
  revokeAgreement: "revoke-agreement",
  // IDM (Integrative Decision-Making)
  idmPropose: "idm-propose",
  idmGet: "idm-get",
  idmAddQuestion: "idm-add-question",
  idmAddReaction: "idm-add-reaction",
  idmAddAmendment: "idm-add-amendment",
  idmRaiseObjection: "idm-raise-objection",
  idmValidateObjection: "idm-validate-objection",
  idmIntegrate: "idm-integrate",
  idmAdvance: "idm-advance",
  // Phase 2 — Cross-links (Concept 1)
  createCrossLink: "create-cross-link",
  listCircleCrossLinks: "list-circle-cross-links",
  dissolveCrossLink: "dissolve-cross-link",
  // Phase 2 — Role-release lifecycle (Concept 3)
  requestRoleRelease: "request-role-release",
  acceptRoleRelease: "accept-role-release",
  completeRoleRelease: "complete-role-release",
  listRoleReleases: "list-role-releases",
  // Phase 2 — Tactical + cross-role (Concept 6)
  runTacticalPulse: "run-tactical-pulse",
  listTacticalRecords: "list-tactical-records",
  requestFromRole: "request-from-role",
  acceptCrossRoleRequest: "accept-cross-role-request",
  declineCrossRoleRequest: "decline-cross-role-request",
  // Phase 2 — Elections (Concept 8)
  requestElection: "request-election",
  runElectionScoring: "run-election-scoring",
  decideElection: "decide-election",
  cancelElection: "cancel-election",
  listElections: "list-elections",
  // Phase 1.14 — Circle Discussions
  createDiscussion: "create-discussion",
  getDiscussion: "get-discussion",
  concludeDiscussion: "conclude-discussion",
  listCircleDiscussions: "list-circle-discussions",
} as const;
