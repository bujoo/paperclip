import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { API_ROUTES, ROLE_TYPES, TOOL_NAMES, type RoleType, DEFAULT_DOMAIN_REGISTRY, GLOBAL_DOMAIN_REGISTRY_COMPANY_ID, GOVERNANCE_APPROVERS, GOVERNANCE_APPROVAL_TIMEOUT_HOURS, IDM_PHASES, IDM_DEFAULT_PHASE_HOURS, type IdmPhase } from "./constants.js";

interface Circle {
  id: string;
  company_id: string;
  parent_circle_id: string | null;
  name: string;
  purpose: string | null;
  domains: unknown;
  policies: unknown;
  color: string | null;
}

interface Role {
  id: string;
  circle_id: string;
  name: string;
  purpose: string | null;
  role_type: string;
  domains: unknown;
  accountabilities: unknown;
  agent_name?: string;
  agent_id?: string;
}

interface Tension {
  id: string;
  circle_id: string;
  source_agent_id: string | null;
  title: string;
  description: string | null;
  tension_type: string;
  status: string;
}

const CORE_ROLE_DEFS: Array<{ name: string; type: RoleType; purpose: string }> = [
  { name: "Circle Lead", type: ROLE_TYPES.circleLead, purpose: "Hold the circle's overall purpose and manage role assignments" },
  { name: "Facilitator", type: ROLE_TYPES.facilitator, purpose: "Facilitate governance and tactical meetings aligned with the Holacracy constitution" },
  { name: "Secretary", type: ROLE_TYPES.secretary, purpose: "Stabilize the circle's governance records and schedule required meetings" },
  { name: "Circle Rep", type: ROLE_TYPES.circleRep, purpose: "Represent the circle's needs and tensions in the parent circle" },
];

let dbCtx: PluginContext["db"] | null = null;
let httpCtx: PluginContext["http"] | null = null;
let approvalsCtx: PluginContext["approvals"] | null = null;
let issuesCtx: PluginContext["issues"] | null = null;
let mqttCtx: PluginContext["mqtt"] | null = null;
let activityCtx: PluginContext["activity"] | null = null;

function tbl(table: string) {
  if (!dbCtx) throw new Error("DB not initialized");
  return `${dbCtx.namespace}.${table}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The host's project-detail page passes `entityId = project.id` to plugin detailTab data sources.
 * Plugin tables key on `circle_id`, but circles reference projects via `circles.project_id`.
 * Resolve either form to the actual circle UUID so the same source works from both call sites.
 * Returns null when the input doesn't match any circle (by id or by project_id).
 */
async function resolveCircleId(inputId: string | undefined | null): Promise<string | null> {
  if (!inputId || !UUID_RE.test(inputId)) return null;
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{ id: string }>(
    `SELECT id FROM ${tbl("circles")} WHERE id = $1 OR project_id = $1 LIMIT 1`,
    [inputId],
  );
  return rows[0]?.id ?? null;
}

async function queryCircleDetail(circleId: string) {
  if (!dbCtx) throw new Error("DB not initialized");
  const circles = await dbCtx.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
  if (circles.length === 0) return null;
  const roles = await dbCtx.query<Role>(
    `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
    [circleId],
  );
  const subCircles = await dbCtx.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE parent_circle_id = $1`, [circleId]);
  const tensions = await dbCtx.query<Tension>(
    `SELECT * FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 10`,
    [circleId],
  );
  return { circle: circles[0], roles, subCircles, tensions };
}

async function createCircle(companyId: string, name: string, purpose: string | null, parentCircleId: string | null, projectId: string | null, color: string | null) {
  if (!dbCtx) throw new Error("DB not initialized");
  const id = randomUUID();
  // If no project supplied, auto-create a root project for this circle so that
  // circle conversations / meeting routines / directive-spawned work / tensions
  // can be linked back to a project rather than living orphaned.
  let resolvedProjectId = projectId;
  if (!resolvedProjectId) {
    const newProjectId = randomUUID();
    const description = `Root project for the ${name} circle. Holds circle conversations, meeting routines, directive-spawned work, and untriaged tensions.`;
    await dbCtx.execute(
      `INSERT INTO public.projects (id, company_id, name, description) VALUES ($1, $2, $3, $4)`,
      [newProjectId, companyId, name, description],
    );
    resolvedProjectId = newProjectId;
  }
  await dbCtx.execute(
    `INSERT INTO ${tbl("circles")} (id, company_id, name, purpose, parent_circle_id, project_id, color) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, name, purpose, parentCircleId, resolvedProjectId, color],
  );
  for (const def of CORE_ROLE_DEFS) {
    await dbCtx.execute(
      `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), id, def.name, def.purpose, def.type],
    );
  }
  return { id, name, purpose, parentCircleId, projectId: resolvedProjectId, coreRolesCreated: CORE_ROLE_DEFS.length };
}

/**
 * Check if adding these domains to an agent would violate conflict rules.
 * Returns { ok: true } or { ok: false, violation: string }
 * @param excludeRoleId - if provided, ignore the agent's current assignment of this role
 *                       (used during reassignment so a role's own domains don't self-conflict)
 */
async function checkDomainConflict(
  agentId: string,
  newDomains: string[],
  companyId: string,
  excludeRoleId?: string,
): Promise<{ ok: boolean; violation?: string }> {
  if (!dbCtx || newDomains.length === 0) return { ok: true };

  // Get all roles currently assigned to this agent (excluding the role being reassigned, if any)
  const assignments = excludeRoleId
    ? await dbCtx.query<Role>(
        `SELECT r.* FROM ${tbl("roles")} r 
         JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id 
         WHERE ra.agent_id = $1 AND r.id <> $2`,
        [agentId, excludeRoleId],
      )
    : await dbCtx.query<Role>(
        `SELECT r.* FROM ${tbl("roles")} r 
         JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id 
         WHERE ra.agent_id = $1`,
        [agentId],
      );

  // Collect all domains agent already holds
  const existingDomains: Set<string> = new Set();
  for (const role of assignments) {
    const roleDomains = Array.isArray(role.domains) ? role.domains : 
                        typeof role.domains === 'string' ? JSON.parse(role.domains) : [];
    roleDomains.forEach((d: string) => existingDomains.add(d));
  }

  // Get domain conflict registry for this company (plus global defaults via 0-uuid)
  const registry = await dbCtx.query<{ domain_name: string; conflicting_domains: unknown }>(
    `SELECT domain_name, conflicting_domains FROM ${tbl("domain_registry")} WHERE company_id = $1 OR company_id = '00000000-0000-0000-0000-000000000000'`,
    [companyId]
  );

  const conflictMap = new Map<string, string[]>();
  for (const entry of registry) {
    const conflicts = Array.isArray(entry.conflicting_domains) ? entry.conflicting_domains : 
                     typeof entry.conflicting_domains === 'string' ? JSON.parse(entry.conflicting_domains) : [];
    conflictMap.set(entry.domain_name, conflicts as string[]);
  }

  // Bidirectional check: A conflicts with B iff registry says A->B OR B->A
  // 1) New domain explicitly conflicts with an existing domain
  for (const newDomain of newDomains) {
    const conflicts = conflictMap.get(newDomain) || [];
    for (const existing of existingDomains) {
      if (conflicts.includes(existing)) {
        return { 
          ok: false, 
          violation: `Domain conflict: cannot assign "${newDomain}" to agent already holding "${existing}"` 
        };
      }
    }
  }
  // 2) An existing domain explicitly conflicts with a new domain
  for (const existing of existingDomains) {
    const conflicts = conflictMap.get(existing) || [];
    for (const newDomain of newDomains) {
      if (conflicts.includes(newDomain)) {
        return { 
          ok: false, 
          violation: `Domain conflict: agent already holds "${existing}" which conflicts with "${newDomain}"` 
        };
      }
    }
  }
  // 3) New domains conflict with each other (e.g. role grants Sales+Growth in one shot)
  for (let i = 0; i < newDomains.length; i++) {
    const a = newDomains[i];
    const aConflicts = conflictMap.get(a) || [];
    for (let j = i + 1; j < newDomains.length; j++) {
      const b = newDomains[j];
      const bConflicts = conflictMap.get(b) || [];
      if (aConflicts.includes(b) || bConflicts.includes(a)) {
        return { 
          ok: false, 
          violation: `Domain conflict: domains "${a}" and "${b}" cannot coexist on same role` 
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Seed default domain registry entries (idempotent).
 * Uses GLOBAL_DOMAIN_REGISTRY_COMPANY_ID so conflicts apply across all companies
 * unless a per-company override exists.
 */
async function seedDefaultDomainRegistry(): Promise<void> {
  if (!dbCtx) return;
  for (const entry of DEFAULT_DOMAIN_REGISTRY) {
    await dbCtx.execute(
      `INSERT INTO ${tbl("domain_registry")} (id, company_id, domain_name, description, conflicting_domains)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, domain_name) DO UPDATE SET
         description = EXCLUDED.description,
         conflicting_domains = EXCLUDED.conflicting_domains,
         updated_at = NOW()`,
      [
        randomUUID(),
        GLOBAL_DOMAIN_REGISTRY_COMPANY_ID,
        entry.domain,
        entry.description,
        JSON.stringify(entry.conflicts),
      ],
    );
  }
}

/**
 * Create a governance approval on Paperclip for a governance tension.
 * Auto-wires 3 approvers (Strategist, PM, Dev Lead).
 * Uses ctx.approvals SDK capability (no loopback HTTP — SSRF-guard safe).
 * Returns {approvalId} on success or undefined on error.
 */
async function createGovernanceApproval(params: {
  companyId: string;
  tensionId: string;
  title: string;
  description: string | null;
  requestedByAgentId: string | null;
}): Promise<{ approvalId: string } | undefined> {
  if (!approvalsCtx) {
    console.error("[holacracy] approvals capability not initialized");
    return undefined;
  }
  try {
    const approverIds = [
      GOVERNANCE_APPROVERS.strategist,
      GOVERNANCE_APPROVERS.productManager,
      GOVERNANCE_APPROVERS.devLead,
    ];
    const approval = await approvalsCtx.create({
      companyId: params.companyId,
      type: "request_board_approval",
      payload: {
        governance_proposal: {
          tension_id: params.tensionId,
          title: params.title,
          description: params.description ?? "",
        },
        required_approvals: 3,
        approver_agent_ids: approverIds,
        timeout_hours: GOVERNANCE_APPROVAL_TIMEOUT_HOURS,
        on_timeout: "escalate_to_operator",
      },
      requestedByAgentId: params.requestedByAgentId ?? undefined,
    });
    return { approvalId: approval.id };
  } catch (err) {
    console.error(
      "[holacracy] createGovernanceApproval error:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

// ─── Agreements (afspraken) helpers ────────────────────────────────────────
// Holacracy's 3rd governance output (distinct from policies and elections).
// Captures "If Y then X" commitments between roles, intra- or cross-circle.

interface AgreementRow {
  id: string;
  company_id: string;
  scope: string;
  primary_circle_id: string | null;
  parties: unknown;
  title: string;
  condition: string | null;
  commitment: string;
  status: string;
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  proposed_via_tension_id: string | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Three-test objection validity (Concept 7) ─────────────────────────────
// Canonical Holacracy IDM requires every objection on a governance proposal
// to pass three tests:
//   1. unworkable          — proposal causes concrete harm
//   2. followsFromProposal — objection arises from THIS proposal, not pre-existing concerns
//   3. currentNotSpeculation — based on current knowledge, not future speculation
// A rejection on a governance tension via the legacy `decide` route is only
// structurally valid if all three result=true with non-empty rationales.

const objectionTestSchema = z.object({
  result: z.boolean(),
  rationale: z.string().min(1, "rationale must be non-empty"),
});

const objectionBlockSchema = z.object({
  unworkable: objectionTestSchema,
  followsFromProposal: objectionTestSchema,
  currentNotSpeculation: objectionTestSchema,
});

type ObjectionBlock = z.infer<typeof objectionBlockSchema>;

function parseObjectionBlock(
  raw: unknown,
):
  | { ok: true; value: ObjectionBlock }
  | { ok: false; error: string } {
  const result = objectionBlockSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join(".") || "objection";
    return { ok: false, error: `Invalid objection block at ${path}: ${firstIssue?.message ?? "validation failed"}` };
  }
  return { ok: true, value: result.data };
}

const agreementPartySchema = z.object({
  roleId: z.string().min(1),
  circleId: z.string().min(1),
});

const createAgreementSchema = z.object({
  scope: z.enum(["intra_circle", "cross_circle"]),
  primaryCircleId: z.string().min(1),
  parties: z.array(agreementPartySchema).min(1),
  title: z.string().min(1),
  condition: z.string().optional(),
  commitment: z.string().min(1),
  expiresAt: z.string().optional(),
  proposedViaTensionId: z.string().optional(),
});

type CreateAgreementInput = z.infer<typeof createAgreementSchema>;

function parseCreateAgreementInput(
  raw: unknown,
):
  | { ok: true; value: CreateAgreementInput }
  | { ok: false; error: string } {
  const result = createAgreementSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join(".") || "input";
    return { ok: false, error: `Invalid agreement input at ${path}: ${firstIssue?.message ?? "validation failed"}` };
  }
  return { ok: true, value: result.data };
}

/**
 * List agreements where this circle is either the primary circle or has at
 * least one role represented in the parties array. Single SQL query — the
 * parties JSON match uses a sub-select against roles in the circle.
 */
async function listAgreementsForCircle(circleId: string): Promise<AgreementRow[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  return dbCtx.query<AgreementRow>(
    `SELECT a.* FROM ${tbl("agreements")} a
     WHERE a.primary_circle_id = $1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(a.parties) p
          WHERE p->>'circleId' = $1::text
             OR p->>'roleId' IN (SELECT id::text FROM ${tbl("roles")} WHERE circle_id = $1)
        )
     ORDER BY a.created_at DESC`,
    [circleId],
  );
}

async function createAgreement(params: { companyId: string } & CreateAgreementInput): Promise<AgreementRow> {
  if (!dbCtx) throw new Error("DB not initialized");
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("agreements")}
       (id, company_id, scope, primary_circle_id, parties, title, condition, commitment, status, expires_at, proposed_via_tension_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'proposed', $9, $10)`,
    [
      id,
      params.companyId,
      params.scope,
      params.primaryCircleId,
      JSON.stringify(params.parties),
      params.title,
      params.condition ?? null,
      params.commitment,
      params.expiresAt ?? null,
      params.proposedViaTensionId ?? null,
    ],
  );
  const rows = await dbCtx.query<AgreementRow>(`SELECT * FROM ${tbl("agreements")} WHERE id = $1`, [id]);
  return rows[0];
}

async function activateAgreement(id: string): Promise<AgreementRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  await dbCtx.execute(
    `UPDATE ${tbl("agreements")} SET status = 'active', activated_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  );
  const rows = await dbCtx.query<AgreementRow>(`SELECT * FROM ${tbl("agreements")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function revokeAgreement(id: string, reason: string): Promise<AgreementRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  await dbCtx.execute(
    `UPDATE ${tbl("agreements")} SET status = 'revoked', revoked_at = NOW(), revoked_reason = $2, updated_at = NOW() WHERE id = $1`,
    [id, reason],
  );
  const rows = await dbCtx.query<AgreementRow>(`SELECT * FROM ${tbl("agreements")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ─── IDM (Integrative Decision-Making) helpers ─────────────────────────────
// Canonical Holacracy 6-phase async governance protocol that rides on top of
// the existing approvals pipeline. State machine documented in constants.ts
// (IDM_PHASES) and migration 008_idm.sql.

interface IdmApprovalRow {
  id: string;
  company_id: string;
  approval_id: string;
  circle_id: string;
  proposer_agent_id: string | null;
  tension_id: string | null;
  phase: string;
  phase_entered_at: string;
  phase_deadline_at: string;
  proposal: unknown;
  amendments: unknown;
  created_at: string;
  updated_at: string;
}

interface IdmPhaseInputRow {
  id: string;
  idm_id: string;
  phase: string;
  agent_id: string;
  role_id: string | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

interface IdmObjectionRow {
  id: string;
  idm_id: string;
  raised_by_agent_id: string;
  raised_by_role_id: string | null;
  body: string;
  test_unworkable: unknown;
  test_follows_from_proposal: unknown;
  test_current_not_speculation: unknown;
  is_valid: boolean | null;
  validated_at: string | null;
  integrated_at: string | null;
  integration_amendment_id: string | null;
  created_at: string;
}

const idmProposalSchema = z.object({
  kind: z.string().min(1),
  content: z.unknown(),
});

const idmProposeSchema = z.object({
  circleId: z.string().min(1),
  tensionId: z.string().optional(),
  proposerAgentId: z.string().optional(),
  proposal: idmProposalSchema,
});

const idmAddInputBodySchema = z.object({
  body: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  roleId: z.string().optional(),
  agentId: z.string().optional(),
});

const idmObjectionInputSchema = z.object({
  body: z.string().min(1),
  raisedByAgentId: z.string().optional(),
  raisedByRoleId: z.string().optional(),
});

const idmObjectionTestSchema = z.object({
  result: z.boolean(),
  rationale: z.string().min(1),
});

const idmValidateObjectionSchema = z.object({
  tests: z.object({
    unworkable: idmObjectionTestSchema,
    followsFromProposal: idmObjectionTestSchema,
    currentNotSpeculation: idmObjectionTestSchema,
  }),
});

const idmIntegrateSchema = z.object({
  objectionId: z.string().min(1),
  amendment: z.object({
    body: z.string().min(1),
    content: z.unknown().optional(),
  }),
  agentId: z.string().optional(),
  roleId: z.string().optional(),
});

type IdmProposeInput = z.infer<typeof idmProposeSchema>;
type IdmIntegrateInput = z.infer<typeof idmIntegrateSchema>;

function parseZodInput<T>(
  schema: { safeParse: (raw: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ path: (string | number)[]; message: string }> } } },
  raw: unknown,
  label: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error?.issues[0];
    const path = firstIssue?.path.join(".") || "input";
    return { ok: false, error: `Invalid ${label} input at ${path}: ${firstIssue?.message ?? "validation failed"}` };
  }
  return { ok: true, value: result.data as T };
}

// Allowed phase-input kinds per phase. Used both in handler validation and in
// the deadline sweeper transition logic.
const PHASE_ALLOWED_INPUT_KINDS: Record<string, string[]> = {
  proposal: [],
  clarifying: ["question", "clarification"],
  reactions: ["reaction"],
  amend_or_clarify: ["amendment", "clarification"],
  objections: [], // objections go to idm_objections, not idm_phase_inputs
  integration: ["integration"],
  adopted: [],
  dropped: [],
};

function nextDeadlineAt(): string {
  return new Date(Date.now() + IDM_DEFAULT_PHASE_HOURS * 60 * 60 * 1000).toISOString();
}

async function loadIdm(id: string): Promise<IdmApprovalRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const rows = await dbCtx.query<IdmApprovalRow>(`SELECT * FROM ${tbl("idm_approvals")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function loadIdmInputs(idmId: string): Promise<IdmPhaseInputRow[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  return dbCtx.query<IdmPhaseInputRow>(
    `SELECT * FROM ${tbl("idm_phase_inputs")} WHERE idm_id = $1 ORDER BY created_at ASC`,
    [idmId],
  );
}

async function loadIdmObjections(idmId: string): Promise<IdmObjectionRow[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  return dbCtx.query<IdmObjectionRow>(
    `SELECT * FROM ${tbl("idm_objections")} WHERE idm_id = $1 ORDER BY created_at ASC`,
    [idmId],
  );
}

async function loadObjection(objectionId: string): Promise<IdmObjectionRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const rows = await dbCtx.query<IdmObjectionRow>(
    `SELECT * FROM ${tbl("idm_objections")} WHERE id = $1`,
    [objectionId],
  );
  return rows[0] ?? null;
}

/**
 * On adoption, dispatch the proposal payload to the appropriate target table
 * (policies, agreements, roles). Best-effort: missing kinds simply log and
 * leave the IDM row in 'adopted' (the approval is still flipped to approved).
 */
async function applyAdoptedProposal(idm: IdmApprovalRow): Promise<{ kind: string; ok: boolean; targetId?: string; reason?: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const proposal = (idm.proposal as { kind?: string; content?: Record<string, unknown> } | null) ?? null;
  const kind = (proposal?.kind ?? "").toLowerCase();
  const content = (proposal?.content as Record<string, unknown> | undefined) ?? {};

  try {
    if (kind === "policy") {
      const targetId = randomUUID();
      await dbCtx.execute(
        `INSERT INTO ${tbl("policies")} (id, circle_id, title, description, domain) VALUES ($1, $2, $3, $4, $5)`,
        [
          targetId,
          idm.circle_id,
          String(content.title ?? "Untitled policy"),
          String(content.description ?? ""),
          (content.domain as string | undefined) ?? null,
        ],
      );
      return { kind, ok: true, targetId };
    }
    if (kind === "agreement") {
      const targetId = randomUUID();
      await dbCtx.execute(
        `INSERT INTO ${tbl("agreements")}
           (id, company_id, scope, primary_circle_id, parties, title, condition, commitment, status, expires_at, proposed_via_tension_id, approval_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'active', $9, $10, $11)`,
        [
          targetId,
          idm.company_id,
          String(content.scope ?? "intra_circle"),
          idm.circle_id,
          JSON.stringify(content.parties ?? []),
          String(content.title ?? "Untitled agreement"),
          (content.condition as string | undefined) ?? null,
          String(content.commitment ?? ""),
          (content.expiresAt as string | undefined) ?? null,
          idm.tension_id,
          idm.approval_id,
        ],
      );
      return { kind, ok: true, targetId };
    }
    if (kind === "role") {
      const targetId = randomUUID();
      await dbCtx.execute(
        `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          targetId,
          idm.circle_id,
          String(content.name ?? "Untitled role"),
          (content.purpose as string | undefined) ?? null,
          (content.roleType as string | undefined) ?? "custom",
          JSON.stringify(content.accountabilities ?? []),
          JSON.stringify(content.domains ?? []),
        ],
      );
      return { kind, ok: true, targetId };
    }
    if (kind === "add-skill-to-role") {
      const roleId = String(content.roleId ?? "");
      const skillSlug = String(content.skillSlug ?? "");
      const rationale = String(content.rationale ?? "");
      const sourceTensionId = (content.sourceTensionId as string | undefined) ?? null;
      if (!roleId || !skillSlug) {
        return { kind, ok: false, reason: "Missing roleId or skillSlug" };
      }
      const roleRows = await dbCtx.query<{ id: string; circle_id: string; name: string; accountabilities: unknown }>(
        `SELECT id, circle_id, name, accountabilities FROM ${tbl("roles")} WHERE id = $1`,
        [roleId],
      );
      const role = roleRows[0];
      if (!role) {
        console.warn(`[holacracy] add-skill-to-role: role ${roleId} not found; skipping`);
        return { kind, ok: false, reason: `Role ${roleId} not found` };
      }
      const existing = Array.isArray(role.accountabilities) ? (role.accountabilities as unknown[]).map(String) : [];
      if (existing.includes(skillSlug)) {
        if (activityCtx) {
          await activityCtx.log({
            companyId: idm.company_id,
            message: `[holacracy] Skill "${skillSlug}" already present on role ${role.name} — no-op.`,
            entityType: "role",
            entityId: roleId,
            metadata: { kind: "add-skill-to-role", roleId, skillSlug, idempotent: true, idmId: idm.id, sourceTensionId, rationale },
          });
        }
        return { kind, ok: true, targetId: roleId };
      }
      const next = [...existing, skillSlug];
      await dbCtx.execute(
        `UPDATE ${tbl("roles")} SET accountabilities = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [roleId, JSON.stringify(next)],
      );
      if (activityCtx) {
        await activityCtx.log({
          companyId: idm.company_id,
          message: `[holacracy] Added skill "${skillSlug}" to role ${role.name} via IDM adoption.`,
          entityType: "role",
          entityId: roleId,
          metadata: { kind: "add-skill-to-role", roleId, skillSlug, idmId: idm.id, sourceTensionId, rationale },
        });
      }
      return { kind, ok: true, targetId: roleId };
    }
    if (kind === "create-role-with-skill") {
      const circleId = String(content.circleId ?? idm.circle_id ?? "");
      const proposedRoleName = String(content.proposedRoleName ?? "Untitled role");
      const requiredSkills = Array.isArray(content.requiredSkills)
        ? (content.requiredSkills as unknown[]).map(String)
        : [];
      const proposedAgentName = (content.proposedAgentName as string | undefined) ?? null;
      const rationale = String(content.rationale ?? "");
      if (!circleId) {
        return { kind, ok: false, reason: "Missing circleId" };
      }
      const circleRows = await dbCtx.query<{ id: string }>(
        `SELECT id FROM ${tbl("circles")} WHERE id = $1`,
        [circleId],
      );
      if (!circleRows[0]) {
        console.warn(`[holacracy] create-role-with-skill: circle ${circleId} not found; skipping`);
        return { kind, ok: false, reason: `Circle ${circleId} not found` };
      }
      const targetId = randomUUID();
      await dbCtx.execute(
        `INSERT INTO ${tbl("roles")} (id, circle_id, name, role_type, accountabilities) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [targetId, circleId, proposedRoleName, "custom", JSON.stringify(requiredSkills)],
      );
      if (activityCtx) {
        await activityCtx.log({
          companyId: idm.company_id,
          message: `[holacracy] Created role "${proposedRoleName}" in circle ${circleId} with ${requiredSkills.length} required skill(s) via IDM adoption.`,
          entityType: "role",
          entityId: targetId,
          metadata: { kind: "create-role-with-skill", roleId: targetId, circleId, requiredSkills, idmId: idm.id, rationale },
        });
        if (proposedAgentName) {
          await activityCtx.log({
            companyId: idm.company_id,
            message: `[holacracy] Recommendation: onboard a new agent "${proposedAgentName}" to fill role "${proposedRoleName}" (requires human approval).`,
            entityType: "role",
            entityId: targetId,
            metadata: { kind: "create-role-with-skill:onboarding-recommendation", roleId: targetId, proposedAgentName, requiredSkills, idmId: idm.id },
          });
        }
      }
      return { kind, ok: true, targetId };
    }
    if (kind === "reassign-role") {
      const roleId = String(content.roleId ?? "");
      const fromAgentId = String(content.fromAgentId ?? "");
      const toAgentId = String(content.toAgentId ?? "");
      const rationale = String(content.rationale ?? "");
      if (!roleId || !fromAgentId || !toAgentId) {
        return { kind, ok: false, reason: "Missing roleId, fromAgentId, or toAgentId" };
      }
      const existing = await dbCtx.query<{ id: string }>(
        `SELECT id FROM ${tbl("role_assignments")} WHERE role_id = $1 AND agent_id = $2`,
        [roleId, fromAgentId],
      );
      if (!existing[0]) {
        console.warn(`[holacracy] reassign-role: no assignment for role ${roleId} + agent ${fromAgentId}; skipping`);
        return { kind, ok: false, reason: `No assignment found for role ${roleId} + agent ${fromAgentId}` };
      }
      await dbCtx.execute(
        `UPDATE ${tbl("role_assignments")} SET agent_id = $3 WHERE role_id = $1 AND agent_id = $2`,
        [roleId, fromAgentId, toAgentId],
      );
      if (activityCtx) {
        await activityCtx.log({
          companyId: idm.company_id,
          message: `[holacracy] Reassigned role ${roleId} from agent ${fromAgentId} to agent ${toAgentId} via IDM adoption.`,
          entityType: "role",
          entityId: roleId,
          metadata: { kind: "reassign-role", roleId, fromAgentId, toAgentId, idmId: idm.id, rationale },
        });
      }
      return { kind, ok: true, targetId: roleId };
    }
    if (kind === "reformulate-task") {
      const taskId = String(content.taskId ?? "");
      const originalProposerAgentId = String(content.originalProposerAgentId ?? "");
      const clarifyingQuestions = Array.isArray(content.clarifyingQuestions)
        ? (content.clarifyingQuestions as unknown[]).map(String)
        : [];
      if (!taskId || clarifyingQuestions.length === 0) {
        return { kind, ok: false, reason: "Missing taskId or clarifyingQuestions" };
      }
      const issueRows = await dbCtx.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM public.issues WHERE id = $1`,
        [taskId],
      );
      const issue = issueRows[0];
      if (!issue) {
        console.warn(`[holacracy] reformulate-task: issue ${taskId} not found; skipping`);
        return { kind, ok: false, reason: `Issue ${taskId} not found` };
      }
      const interactionId = randomUUID();
      await dbCtx.execute(
        `INSERT INTO public.issue_thread_interactions
           (id, company_id, issue_id, kind, status, continuation_policy, payload, created_by_agent_id)
         VALUES ($1, $2, $3, 'ask_user_questions', 'pending', 'wake_assignee', $4::jsonb, $5)`,
        [
          interactionId,
          issue.company_id,
          taskId,
          JSON.stringify({ questions: clarifyingQuestions }),
          originalProposerAgentId || null,
        ],
      );
      if (activityCtx) {
        await activityCtx.log({
          companyId: idm.company_id,
          message: `[holacracy] Reformulate-task: posted ${clarifyingQuestions.length} clarifying question(s) on issue ${taskId} to wake original proposer.`,
          entityType: "issue",
          entityId: taskId,
          metadata: {
            kind: "reformulate-task",
            taskId,
            originalProposerAgentId,
            interactionId,
            questionCount: clarifyingQuestions.length,
            idmId: idm.id,
          },
        });
      }
      return { kind, ok: true, targetId: interactionId };
    }
    return { kind: kind || "unknown", ok: false, reason: `No dispatcher for proposal.kind="${kind}"` };
  } catch (err) {
    return { kind, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function setIdmPhase(idmId: string, phase: IdmPhase, deadlineAt?: string): Promise<void> {
  if (!dbCtx) throw new Error("DB not initialized");
  const deadline = deadlineAt ?? nextDeadlineAt();
  await dbCtx.execute(
    `UPDATE ${tbl("idm_approvals")} SET phase = $2, phase_entered_at = NOW(), phase_deadline_at = $3, updated_at = NOW() WHERE id = $1`,
    [idmId, phase, deadline],
  );
}

/**
 * idmPropose — open a new IDM process and the companion approvals row.
 */
async function idmPropose(
  params: { companyId: string } & IdmProposeInput,
): Promise<{ idm: IdmApprovalRow; approvalId: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  if (!approvalsCtx) throw new Error("approvals capability not initialized");

  // Create companion approval row first so we have its id to store
  const approverIds = [
    GOVERNANCE_APPROVERS.strategist,
    GOVERNANCE_APPROVERS.productManager,
    GOVERNANCE_APPROVERS.devLead,
  ];
  const approval = await approvalsCtx.create({
    companyId: params.companyId,
    type: "request_board_approval",
    payload: {
      idm_proposal: {
        kind: params.proposal.kind,
        circle_id: params.circleId,
        tension_id: params.tensionId ?? null,
      },
      required_approvals: 3,
      approver_agent_ids: approverIds,
      timeout_hours: GOVERNANCE_APPROVAL_TIMEOUT_HOURS,
      on_timeout: "escalate_to_operator",
    },
    ...(params.proposerAgentId ? { requestedByAgentId: params.proposerAgentId } : {}),
  });

  const id = randomUUID();
  const deadline = nextDeadlineAt();
  await dbCtx.execute(
    `INSERT INTO ${tbl("idm_approvals")}
       (id, company_id, approval_id, circle_id, proposer_agent_id, tension_id, phase, phase_deadline_at, proposal)
     VALUES ($1, $2, $3, $4, $5, $6, 'proposal', $7, $8::jsonb)`,
    [
      id,
      params.companyId,
      approval.id,
      params.circleId,
      params.proposerAgentId ?? null,
      params.tensionId ?? null,
      deadline,
      JSON.stringify(params.proposal),
    ],
  );
  const created = await loadIdm(id);
  if (!created) throw new Error("Failed to load created IDM row");
  return { idm: created, approvalId: approval.id };
}

/**
 * idmAdvance — phase state machine transition. Idempotent if already adopted/dropped.
 *
 * Order:
 *   proposal -> clarifying -> reactions -> amend_or_clarify -> objections -> integration | adopted
 *
 * Special rules:
 *   - objections -> integration  if any valid objection has no integration_amendment_id
 *   - objections -> adopted      if no valid objections (or all integrated) past deadline
 *   - integration -> objections  once an amendment is recorded for an objection (re-test)
 *   - integration -> adopted     after deadline if no pending objections remain
 */
async function idmAdvance(id: string): Promise<IdmApprovalRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const idm = await loadIdm(id);
  if (!idm) return null;
  if (idm.phase === IDM_PHASES.adopted || idm.phase === IDM_PHASES.dropped) return idm;

  const phase = idm.phase as IdmPhase;
  let next: IdmPhase = phase;

  if (phase === IDM_PHASES.proposal) next = IDM_PHASES.clarifying;
  else if (phase === IDM_PHASES.clarifying) next = IDM_PHASES.reactions;
  else if (phase === IDM_PHASES.reactions) next = IDM_PHASES.amendOrClarify;
  else if (phase === IDM_PHASES.amendOrClarify) next = IDM_PHASES.objections;
  else if (phase === IDM_PHASES.objections) {
    const objections = await loadIdmObjections(id);
    const validPending = objections.filter((o) => o.is_valid === true && !o.integration_amendment_id);
    next = validPending.length > 0 ? IDM_PHASES.integration : IDM_PHASES.adopted;
  } else if (phase === IDM_PHASES.integration) {
    // From integration we always loop back to objections for re-test.
    // Adoption from integration only happens via the next objections sweep.
    next = IDM_PHASES.objections;
  }

  if (next === phase) return idm;

  await setIdmPhase(id, next);

  if (next === IDM_PHASES.adopted) {
    // Flip the companion approval to approved and dispatch the proposal output.
    await dbCtx.execute(
      `UPDATE public.approvals SET status = 'approved', decision_note = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [idm.approval_id, "auto:adopted via IDM — no valid objections remain"],
    );
    const applied = await applyAdoptedProposal(idm);
    await dbCtx.execute(
      `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'idm-adopted', $3)`,
      [idm.company_id, idm.circle_id, JSON.stringify({ idmId: id, approvalId: idm.approval_id, applied })],
    );
  }

  return loadIdm(id);
}

async function idmAddInput(params: {
  idmId: string;
  kind: string;
  agentId: string;
  roleId?: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: true; row: IdmPhaseInputRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const idm = await loadIdm(params.idmId);
  if (!idm) return { ok: false, error: "IDM not found" };
  const allowed = PHASE_ALLOWED_INPUT_KINDS[idm.phase] ?? [];
  if (!allowed.includes(params.kind)) {
    return { ok: false, error: `Input kind "${params.kind}" not permitted in phase "${idm.phase}"` };
  }
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("idm_phase_inputs")} (id, idm_id, phase, agent_id, role_id, kind, payload) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, params.idmId, idm.phase, params.agentId, params.roleId ?? null, params.kind, JSON.stringify(params.payload)],
  );
  const rows = await dbCtx.query<IdmPhaseInputRow>(`SELECT * FROM ${tbl("idm_phase_inputs")} WHERE id = $1`, [id]);
  return { ok: true, row: rows[0] };
}

async function idmObject(params: {
  idmId: string;
  raisedByAgentId: string;
  raisedByRoleId?: string;
  body: string;
}): Promise<{ ok: true; row: IdmObjectionRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const idm = await loadIdm(params.idmId);
  if (!idm) return { ok: false, error: "IDM not found" };
  if (idm.phase !== IDM_PHASES.objections) {
    return { ok: false, error: `Cannot raise objection in phase "${idm.phase}"` };
  }
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("idm_objections")} (id, idm_id, raised_by_agent_id, raised_by_role_id, body) VALUES ($1, $2, $3, $4, $5)`,
    [id, params.idmId, params.raisedByAgentId, params.raisedByRoleId ?? null, params.body],
  );
  const rows = await dbCtx.query<IdmObjectionRow>(`SELECT * FROM ${tbl("idm_objections")} WHERE id = $1`, [id]);
  return { ok: true, row: rows[0] };
}

async function idmValidateObjection(
  objectionId: string,
  tests: {
    unworkable: { result: boolean; rationale: string };
    followsFromProposal: { result: boolean; rationale: string };
    currentNotSpeculation: { result: boolean; rationale: string };
  },
): Promise<IdmObjectionRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const isValid = tests.unworkable.result && tests.followsFromProposal.result && tests.currentNotSpeculation.result;
  await dbCtx.execute(
    `UPDATE ${tbl("idm_objections")}
       SET test_unworkable = $2::jsonb,
           test_follows_from_proposal = $3::jsonb,
           test_current_not_speculation = $4::jsonb,
           is_valid = $5,
           validated_at = NOW()
     WHERE id = $1`,
    [
      objectionId,
      JSON.stringify(tests.unworkable),
      JSON.stringify(tests.followsFromProposal),
      JSON.stringify(tests.currentNotSpeculation),
      isValid,
    ],
  );
  return loadObjection(objectionId);
}

async function idmIntegrate(params: {
  idmId: string;
  objectionId: string;
  amendment: { body: string; content?: unknown };
  agentId: string;
  roleId?: string;
}): Promise<{ ok: true; objection: IdmObjectionRow; amendmentInputId: string } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const idm = await loadIdm(params.idmId);
  if (!idm) return { ok: false, error: "IDM not found" };
  if (idm.phase !== IDM_PHASES.integration) {
    return { ok: false, error: `Cannot integrate in phase "${idm.phase}"` };
  }
  const objection = await loadObjection(params.objectionId);
  if (!objection || objection.idm_id !== params.idmId) {
    return { ok: false, error: "Objection not found for this IDM" };
  }
  if (objection.is_valid !== true) {
    return { ok: false, error: "Cannot integrate an objection that is not validated as valid" };
  }

  const amendmentInputId = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("idm_phase_inputs")} (id, idm_id, phase, agent_id, role_id, kind, payload) VALUES ($1, $2, 'integration', $3, $4, 'integration', $5::jsonb)`,
    [
      amendmentInputId,
      params.idmId,
      params.agentId,
      params.roleId ?? null,
      JSON.stringify({ objectionId: params.objectionId, ...params.amendment }),
    ],
  );

  await dbCtx.execute(
    `UPDATE ${tbl("idm_objections")} SET integration_amendment_id = $2, integrated_at = NOW() WHERE id = $1`,
    [params.objectionId, amendmentInputId],
  );

  // Append the amendment summary to idm_approvals.amendments
  await dbCtx.execute(
    `UPDATE ${tbl("idm_approvals")} SET amendments = amendments || $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [
      params.idmId,
      JSON.stringify([
        {
          objectionId: params.objectionId,
          amendmentInputId,
          body: params.amendment.body,
          ...(params.amendment.content !== undefined ? { content: params.amendment.content } : {}),
        },
      ]),
    ],
  );

  const updated = await loadObjection(params.objectionId);
  if (!updated) return { ok: false, error: "Failed to reload objection after integrate" };
  return { ok: true, objection: updated, amendmentInputId };
}

// ─── Phase 2 helpers ───────────────────────────────────────────────────────
//
// Helpers below support Concepts 1, 3, 6, 8, 9.  Append-only block — pre-Phase-2
// helpers must not be modified.

/**
 * Concept 9 — recursive Lead Link assignment authority.
 *
 * In Paperclip's Holacracy schema, the Holacracy "Lead Link" maps to role_type
 * `circle_lead`. To assign a Lead Link in a sub-circle, the caller must hold a
 * Lead Link role in at least one ancestor (parent, grand-parent, ...) of the
 * target circle. Anchor/root circles (no parent) are exempt.
 *
 * Returns ok=false with `reason` describing what failed, ok=true otherwise.
 */
async function isAgentLeadLinkInAncestor(
  agentId: string | null,
  targetCircleId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  // Anchor/root circle — no parent means no enforcement (used for the GCC itself).
  const target = await dbCtx.query<{ parent_circle_id: string | null }>(
    `SELECT parent_circle_id FROM ${tbl("circles")} WHERE id = $1`,
    [targetCircleId],
  );
  if (target.length === 0) return { ok: false, reason: "Target circle not found" };
  let parent: string | null = target[0].parent_circle_id;
  if (parent === null) return { ok: true }; // root — no constraint
  if (!agentId) return { ok: false, reason: "Caller agentId required to validate Lead Link authority" };
  // Walk ancestors; check if caller holds circle_lead in any of them.
  while (parent !== null) {
    const lead: Array<{ agent_id: string | null }> = await dbCtx.query(
      `SELECT ra.agent_id FROM ${tbl("roles")} r
       LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id
       WHERE r.circle_id = $1 AND r.role_type = 'circle_lead'`,
      [parent],
    );
    if (lead.some((rw) => rw.agent_id === agentId)) return { ok: true };
    const nextRow: Array<{ parent_circle_id: string | null }> = await dbCtx.query(
      `SELECT parent_circle_id FROM ${tbl("circles")} WHERE id = $1`,
      [parent],
    );
    parent = nextRow[0]?.parent_circle_id ?? null;
  }
  return { ok: false, reason: "Caller does not hold Lead Link in any parent circle" };
}

/**
 * Find the Lead Link (circle_lead role assignee) agent_id for a circle, if any.
 */
async function findCircleLeadAgentId(circleId: string): Promise<string | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const rows = await dbCtx.query<{ agent_id: string | null }>(
    `SELECT ra.agent_id FROM ${tbl("roles")} r
     JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id
     WHERE r.circle_id = $1 AND r.role_type = 'circle_lead'
     LIMIT 1`,
    [circleId],
  );
  return rows[0]?.agent_id ?? null;
}

/**
 * Detect whether two circles share a common ancestor (for cross-link validation).
 * Also disqualifies if one is an ancestor of the other.
 */
async function circlesShareCommonAncestor(
  circleAId: string,
  circleBId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  if (circleAId === circleBId) return { ok: false, reason: "circle_a and circle_b are the same" };
  async function walkAncestors(id: string): Promise<string[]> {
    const chain: string[] = [id];
    let cur: string | null = id;
    while (cur !== null) {
      const row: Array<{ parent_circle_id: string | null }> = await dbCtx!.query(
        `SELECT parent_circle_id FROM ${tbl("circles")} WHERE id = $1`,
        [cur],
      );
      const p: string | null = row[0]?.parent_circle_id ?? null;
      if (p === null) break;
      chain.push(p);
      cur = p;
    }
    return chain;
  }
  const aChain = await walkAncestors(circleAId);
  const bChain = await walkAncestors(circleBId);
  if (aChain.includes(circleBId)) return { ok: false, reason: "circle_b is an ancestor of circle_a" };
  if (bChain.includes(circleAId)) return { ok: false, reason: "circle_a is an ancestor of circle_b" };
  const aSet = new Set(aChain);
  for (const b of bChain) {
    if (aSet.has(b)) return { ok: true };
  }
  return { ok: false, reason: "Circles do not share a common ancestor" };
}

// ─── Concept 1 — Cross-links helpers ────────────────────────────────────────

interface CrossLinkRow {
  id: string;
  company_id: string;
  circle_a_id: string;
  circle_b_id: string;
  rep_role_a_id: string;
  rep_role_b_id: string;
  purpose: string;
  created_via_tension_id: string | null;
  status: string;
  dissolved_at: string | null;
  dissolved_reason: string | null;
  created_at: string;
}

const createCrossLinkSchema = z.object({
  circleAId: z.string().min(1),
  circleBId: z.string().min(1),
  repRoleAId: z.string().min(1),
  repRoleBId: z.string().min(1),
  purpose: z.string().min(1),
  createdViaTensionId: z.string().optional(),
});

type CreateCrossLinkInput = z.infer<typeof createCrossLinkSchema>;

async function listCrossLinksForCircle(circleId: string): Promise<CrossLinkRow[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  // JOIN circles + rep roles so the UI can render human names instead of raw UUIDs.
  return dbCtx.query<CrossLinkRow>(
    `SELECT cl.*,
            ca.name AS circle_a_name,
            cb.name AS circle_b_name,
            ra.name AS rep_role_a_name,
            rb.name AS rep_role_b_name
       FROM ${tbl("circle_cross_links")} cl
       LEFT JOIN ${tbl("circles")} ca ON ca.id = cl.circle_a_id
       LEFT JOIN ${tbl("circles")} cb ON cb.id = cl.circle_b_id
       LEFT JOIN ${tbl("roles")} ra ON ra.id = cl.rep_role_a_id
       LEFT JOIN ${tbl("roles")} rb ON rb.id = cl.rep_role_b_id
      WHERE (cl.circle_a_id = $1 OR cl.circle_b_id = $1)
      ORDER BY cl.created_at DESC`,
    [circleId],
  );
}

async function getCrossLink(id: string): Promise<CrossLinkRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const rows = await dbCtx.query<CrossLinkRow>(
    `SELECT * FROM ${tbl("circle_cross_links")} WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Create a cross-link. Verifies (a) circles share a common ancestor and neither
 * is ancestor of the other, (b) no active duplicate exists for the same
 * unordered (circle_a, circle_b) pair. Uses SELECT-then-INSERT in a single
 * logical pass; UNIQUE INDEX is not permitted by the plugin migration validator.
 */
async function createCrossLink(
  companyId: string,
  input: CreateCrossLinkInput,
): Promise<{ ok: true; row: CrossLinkRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  if (input.circleAId === input.circleBId) {
    return { ok: false, error: "circle_a_id and circle_b_id must differ" };
  }
  const ancestorCheck = await circlesShareCommonAncestor(input.circleAId, input.circleBId);
  if (!ancestorCheck.ok) {
    return { ok: false, error: ancestorCheck.reason };
  }
  // Existence check — block when an active row exists for either (a,b) or (b,a).
  const existing = await dbCtx.query<{ id: string }>(
    `SELECT id FROM ${tbl("circle_cross_links")}
     WHERE status = 'active'
       AND ((circle_a_id = $1 AND circle_b_id = $2) OR (circle_a_id = $2 AND circle_b_id = $1))
     LIMIT 1`,
    [input.circleAId, input.circleBId],
  );
  if (existing.length > 0) {
    return { ok: false, error: `An active cross-link already exists between these circles (id=${existing[0].id})` };
  }
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("circle_cross_links")}
       (id, company_id, circle_a_id, circle_b_id, rep_role_a_id, rep_role_b_id, purpose, created_via_tension_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      companyId,
      input.circleAId,
      input.circleBId,
      input.repRoleAId,
      input.repRoleBId,
      input.purpose,
      input.createdViaTensionId ?? null,
    ],
  );
  const row = await getCrossLink(id);
  if (!row) return { ok: false, error: "Failed to load created cross-link" };
  return { ok: true, row };
}

async function dissolveCrossLink(
  id: string,
  reason: string,
): Promise<CrossLinkRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  await dbCtx.execute(
    `UPDATE ${tbl("circle_cross_links")}
       SET status = 'dissolved', dissolved_at = NOW(), dissolved_reason = $2
     WHERE id = $1 AND status = 'active'`,
    [id, reason],
  );
  return getCrossLink(id);
}

/**
 * Publish a cross-link event to both rep agents' event topics. Best-effort —
 * MQTT may be unavailable in some test envs.
 */
async function publishCrossLinkEvent(
  row: CrossLinkRow,
  kind: "cross_link.created" | "cross_link.dissolved",
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!mqttCtx) return;
  try {
    const { eventTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
    // Look up rep agents for each side
    const repAgents = await dbCtx!.query<{ role_id: string; agent_id: string | null }>(
      `SELECT ra.role_id, ra.agent_id FROM ${tbl("role_assignments")} ra
       WHERE ra.role_id = ANY($1::uuid[])`,
      [[row.rep_role_a_id, row.rep_role_b_id]],
    );
    const repAByAgent = repAgents.find((r) => r.role_id === row.rep_role_a_id)?.agent_id ?? null;
    const repBByAgent = repAgents.find((r) => r.role_id === row.rep_role_b_id)?.agent_id ?? null;
    const payload = {
      kind,
      crossLinkId: row.id,
      circleAId: row.circle_a_id,
      circleBId: row.circle_b_id,
      purpose: row.purpose,
      status: row.status,
      ...(extra ?? {}),
    };
    const tasks: Array<Promise<void>> = [];
    if (repAByAgent) {
      tasks.push(mqttCtx.publish(eventTopic(row.company_id, row.circle_a_id, repAByAgent), payload));
    }
    if (repBByAgent) {
      tasks.push(mqttCtx.publish(eventTopic(row.company_id, row.circle_b_id, repBByAgent), payload));
    }
    await Promise.all(tasks);
  } catch (err) {
    console.warn("[holacracy] publishCrossLinkEvent failed:", err instanceof Error ? err.message : String(err));
  }
}

// ─── Concept 3 — Role-release lifecycle helpers ─────────────────────────────

interface RoleReleaseRow {
  id: string;
  company_id: string;
  role_assignment_id: string;
  released_by_agent_id: string;
  handoff_to_agent_id: string | null;
  handoff_notes: string | null;
  reason: string | null;
  requested_at: string;
  accepted_by_lead_link_at: string | null;
  accepted_by_lead_link_agent_id: string | null;
  completed_at: string | null;
  status: string;
}

const requestReleaseSchema = z.object({
  releasedByAgentId: z.string().min(1),
  handoffToAgentId: z.string().optional(),
  handoffNotes: z.string().optional(),
  reason: z.string().optional(),
});

type RequestReleaseInput = z.infer<typeof requestReleaseSchema>;

async function getRoleAssignment(
  assignmentId: string,
): Promise<{ id: string; role_id: string; agent_id: string; release_state: string } | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  const rows = await dbCtx.query<{ id: string; role_id: string; agent_id: string; release_state: string }>(
    `SELECT id, role_id, agent_id, release_state FROM ${tbl("role_assignments")} WHERE id = $1`,
    [assignmentId],
  );
  return rows[0] ?? null;
}

async function requestRoleRelease(
  companyId: string,
  assignmentId: string,
  input: RequestReleaseInput,
): Promise<{ ok: true; release: RoleReleaseRow; tensionId: string } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const assignment = await getRoleAssignment(assignmentId);
  if (!assignment) return { ok: false, error: "Role assignment not found" };
  if (assignment.release_state !== "active") {
    return { ok: false, error: `Cannot request release — assignment is in state "${assignment.release_state}"` };
  }
  // Look up role + circle for context
  const roleRows = await dbCtx.query<{ id: string; circle_id: string; name: string }>(
    `SELECT id, circle_id, name FROM ${tbl("roles")} WHERE id = $1`,
    [assignment.role_id],
  );
  if (roleRows.length === 0) return { ok: false, error: "Role not found" };
  const role = roleRows[0];
  // Idempotency: don't create a second open release row
  const existing = await dbCtx.query<{ id: string }>(
    `SELECT id FROM ${tbl("role_releases")} WHERE role_assignment_id = $1 AND status = 'requested' LIMIT 1`,
    [assignmentId],
  );
  if (existing.length > 0) return { ok: false, error: "An open release request already exists for this assignment" };
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("role_releases")}
       (id, company_id, role_assignment_id, released_by_agent_id, handoff_to_agent_id, handoff_notes, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      companyId,
      assignmentId,
      input.releasedByAgentId,
      input.handoffToAgentId ?? null,
      input.handoffNotes ?? null,
      input.reason ?? null,
    ],
  );
  await dbCtx.execute(
    `UPDATE ${tbl("role_assignments")} SET release_state = 'release_requested' WHERE id = $1`,
    [assignmentId],
  );
  // Raise operational tension with idempotency-keyed title
  const tensionId = randomUUID();
  const title = `[RELEASE:${assignmentId}] Role release requested: ${role.name}`;
  const description = `Agent ${input.releasedByAgentId} has requested to release role "${role.name}". Reason: ${input.reason ?? "(none)"}. Handoff to: ${input.handoffToAgentId ?? "(unassigned)"}. Notes: ${input.handoffNotes ?? "(none)"}.`;
  await dbCtx.execute(
    `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, 'operational')`,
    [tensionId, role.circle_id, input.releasedByAgentId, title, description],
  );
  await dbCtx.execute(
    `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-release-requested', $4)`,
    [companyId, input.releasedByAgentId, role.circle_id, JSON.stringify({ releaseId: id, assignmentId, tensionId, reason: input.reason })],
  );
  const rows = await dbCtx.query<RoleReleaseRow>(`SELECT * FROM ${tbl("role_releases")} WHERE id = $1`, [id]);
  return { ok: true, release: rows[0], tensionId };
}

async function acceptRoleRelease(
  companyId: string,
  releaseId: string,
  acceptedByAgentId: string,
): Promise<{ ok: true; release: RoleReleaseRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const releaseRows = await dbCtx.query<RoleReleaseRow>(
    `SELECT * FROM ${tbl("role_releases")} WHERE id = $1`,
    [releaseId],
  );
  if (releaseRows.length === 0) return { ok: false, error: "Release not found" };
  const release = releaseRows[0];
  if (release.status !== "requested") return { ok: false, error: `Cannot accept in status "${release.status}"` };
  await dbCtx.execute(
    `UPDATE ${tbl("role_releases")}
       SET status = 'pending_handoff', accepted_by_lead_link_at = NOW(), accepted_by_lead_link_agent_id = $2
     WHERE id = $1`,
    [releaseId, acceptedByAgentId],
  );
  await dbCtx.execute(
    `UPDATE ${tbl("role_assignments")} SET release_state = 'release_pending_handoff' WHERE id = $1`,
    [release.role_assignment_id],
  );
  await dbCtx.execute(
    `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, action_type, action_detail) VALUES ($1, $2, 'role-release-accepted', $3)`,
    [companyId, acceptedByAgentId, JSON.stringify({ releaseId })],
  );
  const updated = await dbCtx.query<RoleReleaseRow>(`SELECT * FROM ${tbl("role_releases")} WHERE id = $1`, [releaseId]);
  return { ok: true, release: updated[0] };
}

async function completeRoleRelease(
  companyId: string,
  releaseId: string,
): Promise<{ ok: true; release: RoleReleaseRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const releaseRows = await dbCtx.query<RoleReleaseRow>(
    `SELECT * FROM ${tbl("role_releases")} WHERE id = $1`,
    [releaseId],
  );
  if (releaseRows.length === 0) return { ok: false, error: "Release not found" };
  const release = releaseRows[0];
  if (release.status !== "pending_handoff") {
    return { ok: false, error: `Cannot complete in status "${release.status}"` };
  }
  // If handoff_to_agent_id present, reassign; otherwise just delete the assignment.
  const assignment = await getRoleAssignment(release.role_assignment_id);
  if (!assignment) return { ok: false, error: "Original role_assignment row is gone" };
  if (release.handoff_to_agent_id) {
    await dbCtx.execute(
      `UPDATE ${tbl("role_assignments")} SET agent_id = $2, release_state = 'active' WHERE id = $1`,
      [release.role_assignment_id, release.handoff_to_agent_id],
    );
  } else {
    await dbCtx.execute(
      `UPDATE ${tbl("role_assignments")} SET release_state = 'released' WHERE id = $1`,
      [release.role_assignment_id],
    );
    await dbCtx.execute(
      `DELETE FROM ${tbl("role_assignments")} WHERE id = $1`,
      [release.role_assignment_id],
    );
  }
  await dbCtx.execute(
    `UPDATE ${tbl("role_releases")} SET status = 'completed', completed_at = NOW() WHERE id = $1`,
    [releaseId],
  );
  await dbCtx.execute(
    `INSERT INTO ${tbl("audit_log")} (company_id, action_type, action_detail) VALUES ($1, 'role-release-completed', $2)`,
    [companyId, JSON.stringify({ releaseId, assignmentId: release.role_assignment_id, handoffToAgentId: release.handoff_to_agent_id })],
  );
  const updated = await dbCtx.query<RoleReleaseRow>(`SELECT * FROM ${tbl("role_releases")} WHERE id = $1`, [releaseId]);
  return { ok: true, release: updated[0] };
}

async function listRoleReleases(circleId?: string, status?: string): Promise<RoleReleaseRow[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  const where: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  if (circleId) {
    where.push(`rr.role_assignment_id IN (
      SELECT ra2.id FROM ${tbl("role_assignments")} ra2
      JOIN ${tbl("roles")} r2 ON r2.id = ra2.role_id
      WHERE r2.circle_id = $${idx++}
    )`);
    vals.push(circleId);
  }
  if (status) { where.push(`rr.status = $${idx++}`); vals.push(status); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  // JOIN role + agent tables so the UI can render human names instead of raw UUIDs.
  return dbCtx.query<RoleReleaseRow>(
    `SELECT rr.*,
            r.name AS role_name,
            relAg.name AS released_by_agent_name,
            handAg.name AS handoff_to_agent_name,
            accAg.name AS accepted_by_lead_link_agent_name
       FROM ${tbl("role_releases")} rr
       LEFT JOIN ${tbl("role_assignments")} ra ON ra.id = rr.role_assignment_id
       LEFT JOIN ${tbl("roles")} r ON r.id = ra.role_id
       LEFT JOIN public.agents relAg ON relAg.id = rr.released_by_agent_id
       LEFT JOIN public.agents handAg ON handAg.id = rr.handoff_to_agent_id
       LEFT JOIN public.agents accAg ON accAg.id = rr.accepted_by_lead_link_agent_id
       ${whereSql}
      ORDER BY rr.requested_at DESC`,
    vals,
  );
}

// ─── Concept 6 — Tactical pulses + cross-role requests ──────────────────────

interface TacticalRecordRow {
  id: string;
  company_id: string;
  circle_id: string;
  cadence: string;
  summary: unknown;
  recorded_at: string;
}

interface CrossRoleRequestRow {
  id: string;
  company_id: string;
  requesting_role_id: string;
  target_role_id: string;
  kind: string;
  body: string;
  status: string;
  issue_id: string | null;
  decline_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

async function runTacticalPulse(
  companyId: string,
  circleId: string,
  cadence: string,
): Promise<{ record: TacticalRecordRow; circleAgents: string[] }> {
  if (!dbCtx) throw new Error("DB not initialized");
  // Gather basic signals: open tensions count, role-assignment count, open releases.
  const tCount = await dbCtx.query<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open'`,
    [circleId],
  );
  const raCount = await dbCtx.query<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM ${tbl("role_assignments")} ra
     JOIN ${tbl("roles")} r ON r.id = ra.role_id WHERE r.circle_id = $1`,
    [circleId],
  );
  const summary = {
    openTensions: tCount[0]?.count ?? 0,
    activeAssignments: raCount[0]?.count ?? 0,
    cadence,
    recordedAt: new Date().toISOString(),
  };
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("tactical_records")} (id, company_id, circle_id, cadence, summary) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, companyId, circleId, cadence, JSON.stringify(summary)],
  );
  // Gather all agents in the circle (those holding any role)
  const agents = await dbCtx.query<{ agent_id: string }>(
    `SELECT DISTINCT ra.agent_id FROM ${tbl("role_assignments")} ra
     JOIN ${tbl("roles")} r ON r.id = ra.role_id
     WHERE r.circle_id = $1 AND ra.agent_id IS NOT NULL`,
    [circleId],
  );
  const rows = await dbCtx.query<TacticalRecordRow>(
    `SELECT * FROM ${tbl("tactical_records")} WHERE id = $1`,
    [id],
  );
  return { record: rows[0], circleAgents: agents.map((a) => a.agent_id) };
}

const crossRoleRequestSchema = z.object({
  requestingRoleId: z.string().min(1),
  kind: z.enum(["next_action", "project", "info"]),
  body: z.string().min(1),
  requestingAgentId: z.string().optional(),
});

type CrossRoleRequestInput = z.infer<typeof crossRoleRequestSchema>;

async function requestFromRole(
  companyId: string,
  targetRoleId: string,
  input: CrossRoleRequestInput,
): Promise<{ ok: true; row: CrossRoleRequestRow; targetAgentId: string | null; targetCircleId: string | null; issueId: string | null } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  // Look up the target role + its current assignee + circle
  const target = await dbCtx.query<{ id: string; circle_id: string; name: string }>(
    `SELECT id, circle_id, name FROM ${tbl("roles")} WHERE id = $1`,
    [targetRoleId],
  );
  if (target.length === 0) return { ok: false, error: "Target role not found" };
  const role = target[0];
  const assignee = await dbCtx.query<{ agent_id: string | null }>(
    `SELECT agent_id FROM ${tbl("role_assignments")} WHERE role_id = $1 LIMIT 1`,
    [targetRoleId],
  );
  const targetAgentId = assignee[0]?.agent_id ?? null;
  const id = randomUUID();
  let issueId: string | null = null;
  // Create durable issue for next_action / project
  if ((input.kind === "next_action" || input.kind === "project") && issuesCtx && targetAgentId) {
    try {
      const created = await issuesCtx.create({
        companyId,
        title: `[CROSS-ROLE:${id}] ${input.kind === "project" ? "Project" : "Next action"} request to ${role.name}`,
        description: input.body,
        status: "todo",
        assigneeAgentId: targetAgentId,
        originKind: "plugin:paperclipai.plugin-holacracy:cross-role-request",
        originId: id,
      });
      issueId = created.id;
    } catch (err) {
      console.warn("[holacracy] cross-role request issue create failed:", err instanceof Error ? err.message : String(err));
    }
  }
  await dbCtx.execute(
    `INSERT INTO ${tbl("cross_role_requests")} (id, company_id, requesting_role_id, target_role_id, kind, body, issue_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, input.requestingRoleId, targetRoleId, input.kind, input.body, issueId],
  );
  const rows = await dbCtx.query<CrossRoleRequestRow>(
    `SELECT * FROM ${tbl("cross_role_requests")} WHERE id = $1`,
    [id],
  );
  return { ok: true, row: rows[0], targetAgentId, targetCircleId: role.circle_id, issueId };
}

async function decideCrossRoleRequest(
  companyId: string,
  requestId: string,
  decision: "accepted" | "declined",
  declineReason?: string,
): Promise<{ ok: true; row: CrossRoleRequestRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const existing = await dbCtx.query<CrossRoleRequestRow>(
    `SELECT * FROM ${tbl("cross_role_requests")} WHERE id = $1`,
    [requestId],
  );
  if (existing.length === 0) return { ok: false, error: "Cross-role request not found" };
  if (existing[0].status !== "pending") return { ok: false, error: `Cannot decide a request in status "${existing[0].status}"` };
  await dbCtx.execute(
    `UPDATE ${tbl("cross_role_requests")} SET status = $2, decided_at = NOW(), decline_reason = $3 WHERE id = $1`,
    [requestId, decision, declineReason ?? null],
  );
  await dbCtx.execute(
    `INSERT INTO ${tbl("audit_log")} (company_id, action_type, action_detail) VALUES ($1, 'cross-role-request-decided', $2)`,
    [companyId, JSON.stringify({ requestId, decision, declineReason })],
  );
  const rows = await dbCtx.query<CrossRoleRequestRow>(
    `SELECT * FROM ${tbl("cross_role_requests")} WHERE id = $1`,
    [requestId],
  );
  return { ok: true, row: rows[0] };
}

// ─── Concept 8 — Election helpers ───────────────────────────────────────────

interface ElectionRequestRow {
  id: string;
  company_id: string;
  circle_id: string;
  target_role_id: string;
  requested_by_agent_id: string | null;
  status: string;
  decision_agent_id: string | null;
  decided_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

interface ElectionCandidateRow {
  id: string;
  election_id: string;
  agent_id: string;
  capability_score: number;
  load_score: number;
  composite_score: number;
  rationale: unknown;
  created_at: string;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.toLowerCase().trim()).filter(Boolean));
  const setB = new Set(b.map((s) => s.toLowerCase().trim()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface CandidatePool {
  agentId: string;
  skills: string[];
  focusAp: number;
}

/**
 * Collect candidates via MQTT retained Agent Cards (preferred) — falls back to
 * SQL agents table on any MQTT failure. The settle window is short because
 * retained Cards arrive immediately on subscribe.
 */
async function collectCandidatesViaMqtt(
  companyId: string,
  settleMs = 1500,
): Promise<CandidatePool[] | null> {
  if (!mqttCtx) return null;
  try {
    const { discoveryWildcard } = await import("@paperclipai/adapter-a2a-mqtt/server");
    const collected = new Map<string, CandidatePool>();
    const unsub = mqttCtx.on(discoveryWildcard(companyId), (msg) => {
      try {
        const text = msg.payload.toString("utf8");
        if (!text) return;
        const card = JSON.parse(text) as { agentId?: string; skills?: string[]; focusAp?: number };
        if (!card.agentId) return;
        collected.set(card.agentId, {
          agentId: card.agentId,
          skills: Array.isArray(card.skills) ? card.skills : [],
          focusAp: typeof card.focusAp === "number" ? card.focusAp : 0,
        });
      } catch {
        // ignore malformed cards
      }
    });
    await new Promise((r) => setTimeout(r, settleMs));
    await unsub();
    return Array.from(collected.values());
  } catch (err) {
    console.warn("[holacracy] MQTT candidate discovery failed, falling back:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function collectCandidatesViaSql(companyId: string): Promise<CandidatePool[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  // Pull from public.agents + role_assignments.focus_ap totals
  const agents = await dbCtx.query<{ id: string; accountabilities: unknown }>(
    `SELECT id, accountabilities FROM public.agents WHERE company_id = $1`,
    [companyId],
  );
  const out: CandidatePool[] = [];
  for (const a of agents) {
    const skills = Array.isArray(a.accountabilities)
      ? (a.accountabilities as Array<string | { name?: string }>).map((s) => (typeof s === "string" ? s : s?.name ?? "")).filter(Boolean)
      : [];
    const focus = await dbCtx.query<{ total: number }>(
      `SELECT COALESCE(SUM(focus_ap), 0)::int as total FROM ${tbl("role_assignments")} WHERE agent_id = $1`,
      [a.id],
    );
    out.push({ agentId: a.id, skills, focusAp: focus[0]?.total ?? 0 });
  }
  return out;
}

async function runElectionScoring(
  electionId: string,
): Promise<{ ok: true; candidates: ElectionCandidateRow[] } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const electionRows = await dbCtx.query<ElectionRequestRow>(
    `SELECT * FROM ${tbl("role_election_requests")} WHERE id = $1`,
    [electionId],
  );
  if (electionRows.length === 0) return { ok: false, error: "Election not found" };
  const election = electionRows[0];
  if (election.status !== "scoring" && election.status !== "open") {
    return { ok: false, error: `Cannot score in status "${election.status}"` };
  }
  // Target role accountabilities
  const role = await dbCtx.query<{ id: string; accountabilities: unknown; domains: unknown }>(
    `SELECT id, accountabilities, domains FROM ${tbl("roles")} WHERE id = $1`,
    [election.target_role_id],
  );
  if (role.length === 0) return { ok: false, error: "Target role not found" };
  const roleAccount = Array.isArray(role[0].accountabilities)
    ? (role[0].accountabilities as Array<string | { name?: string }>).map((s) => (typeof s === "string" ? s : s?.name ?? "")).filter(Boolean)
    : [];
  const roleDomains = Array.isArray(role[0].domains)
    ? (role[0].domains as string[])
    : [];
  // Domain conflict registry lookup
  const conflictRegistry = await dbCtx.query<{ domain_name: string; conflicting_domains: unknown }>(
    `SELECT domain_name, conflicting_domains FROM ${tbl("domain_registry")} WHERE company_id = $1 OR company_id = '00000000-0000-0000-0000-000000000000'`,
    [election.company_id],
  );
  const conflictMap = new Map<string, string[]>();
  for (const c of conflictRegistry) {
    const list = Array.isArray(c.conflicting_domains) ? c.conflicting_domains : [];
    conflictMap.set(c.domain_name, list as string[]);
  }
  // Candidate discovery — MQTT first
  let pool = await collectCandidatesViaMqtt(election.company_id);
  if (!pool || pool.length === 0) {
    pool = await collectCandidatesViaSql(election.company_id);
  }
  // For each candidate, also pull conflicts from their existing domains.
  const out: ElectionCandidateRow[] = [];
  for (const cand of pool) {
    const capScore = jaccard(cand.skills, roleAccount);
    const load = 1.0 - Math.min(cand.focusAp, 100) / 100;
    const loadScore = Math.max(load, 0);
    // Conflicts via domain_registry vs the agent's current domains
    const existingDomains = await dbCtx.query<{ domain: string }>(
      `SELECT unnest(
         CASE WHEN jsonb_typeof(r.domains) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r.domains)) ELSE ARRAY[]::text[] END
       ) AS domain
       FROM ${tbl("roles")} r
       JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id
       WHERE ra.agent_id = $1`,
      [cand.agentId],
    );
    const heldDomains = new Set(existingDomains.map((d) => d.domain));
    const conflicts: string[] = [];
    for (const rd of roleDomains) {
      const conflictsForRd = conflictMap.get(rd) ?? [];
      for (const cd of conflictsForRd) {
        if (heldDomains.has(cd)) conflicts.push(`${rd} conflicts with held ${cd}`);
      }
    }
    const matchedAccount = roleAccount.filter((a) => cand.skills.map((s) => s.toLowerCase().trim()).includes(a.toLowerCase().trim()));
    const gaps = roleAccount.filter((a) => !matchedAccount.includes(a));
    const composite = 0.7 * capScore + 0.3 * loadScore;
    const id = randomUUID();
    const rationale = { matchedAccountabilities: matchedAccount, gaps, conflicts };
    await dbCtx.execute(
      `INSERT INTO ${tbl("role_election_candidates")} (id, election_id, agent_id, capability_score, load_score, composite_score, rationale) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [id, electionId, cand.agentId, capScore, loadScore, composite, JSON.stringify(rationale)],
    );
    out.push({
      id,
      election_id: electionId,
      agent_id: cand.agentId,
      capability_score: capScore,
      load_score: loadScore,
      composite_score: composite,
      rationale,
      created_at: new Date().toISOString(),
    });
  }
  await dbCtx.execute(
    `UPDATE ${tbl("role_election_requests")} SET status = 'scored' WHERE id = $1`,
    [electionId],
  );
  return { ok: true, candidates: out };
}

async function requestElection(
  companyId: string,
  input: { circleId: string; targetRoleId: string; requestedByAgentId?: string | null },
): Promise<ElectionRequestRow> {
  if (!dbCtx) throw new Error("DB not initialized");
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("role_election_requests")} (id, company_id, circle_id, target_role_id, requested_by_agent_id, status) VALUES ($1, $2, $3, $4, $5, 'open')`,
    [id, companyId, input.circleId, input.targetRoleId, input.requestedByAgentId ?? null],
  );
  const rows = await dbCtx.query<ElectionRequestRow>(`SELECT * FROM ${tbl("role_election_requests")} WHERE id = $1`, [id]);
  return rows[0];
}

async function decideElection(
  electionId: string,
  decisionAgentId: string,
): Promise<{ ok: true; election: ElectionRequestRow } | { ok: false; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const rows = await dbCtx.query<ElectionRequestRow>(`SELECT * FROM ${tbl("role_election_requests")} WHERE id = $1`, [electionId]);
  if (rows.length === 0) return { ok: false, error: "Election not found" };
  const election = rows[0];
  if (election.status === "cancelled" || election.status === "decided") {
    return { ok: false, error: `Cannot decide an election in status "${election.status}"` };
  }
  // Assign the role (insert/replace role_assignments)
  await dbCtx.execute(`DELETE FROM ${tbl("role_assignments")} WHERE role_id = $1`, [election.target_role_id]);
  await dbCtx.execute(
    `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
    [randomUUID(), election.target_role_id, decisionAgentId],
  );
  await dbCtx.execute(
    `UPDATE ${tbl("role_election_requests")} SET status = 'decided', decision_agent_id = $2, decided_at = NOW() WHERE id = $1`,
    [electionId, decisionAgentId],
  );
  const updated = await dbCtx.query<ElectionRequestRow>(`SELECT * FROM ${tbl("role_election_requests")} WHERE id = $1`, [electionId]);
  return { ok: true, election: updated[0] };
}

async function cancelElection(electionId: string): Promise<ElectionRequestRow | null> {
  if (!dbCtx) throw new Error("DB not initialized");
  await dbCtx.execute(
    `UPDATE ${tbl("role_election_requests")} SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1 AND status NOT IN ('cancelled', 'decided')`,
    [electionId],
  );
  const rows = await dbCtx.query<ElectionRequestRow>(`SELECT * FROM ${tbl("role_election_requests")} WHERE id = $1`, [electionId]);
  return rows[0] ?? null;
}

// ─── Phase 1.13 — Speech tool helpers ──────────────────────────────────────

interface ToolRunContextLike {
  agentId: string;
  companyId: string;
}

interface TalkToAgentParams {
  toAgentId: string;
  text: string;
  contextId?: string;
  awaitReply?: boolean;
  timeoutMs?: number;
}

interface ReplyOnTaskParams {
  issueId: string;
  state: "completed" | "input_required" | "failed";
  text?: string;
  artifacts?: unknown[];
}

interface BroadcastToCircleParams {
  circleId: string;
  kind: string;
  body: unknown;
}

interface RaiseTensionOnBusParams {
  circleId: string;
  title: string;
  body: string;
  severity?: "low" | "medium" | "high";
}

interface AskSkillParams {
  skill: string;
  text: string;
  contextId?: string;
  awaitReply?: boolean;
  timeoutMs?: number;
}

/**
 * Resolve a target agent's `(companyId, circleId)` for routing an A2A
 * personal-direct request. Picks any circle the target agent holds a role
 * in, preferring matches inside the caller's company so cross-company
 * routing requires explicit support (not in scope for Phase 1.13).
 */
async function resolveAgentHomeCircle(
  callerCompanyId: string,
  targetAgentId: string,
): Promise<{ companyId: string; circleId: string } | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{ company_id: string; circle_id: string }>(
    `SELECT c.company_id, c.id AS circle_id
       FROM ${tbl("role_assignments")} ra
       JOIN ${tbl("roles")} r ON r.id = ra.role_id
       JOIN ${tbl("circles")} c ON c.id = r.circle_id
      WHERE ra.agent_id = $1::uuid
        AND c.company_id = $2::uuid
      LIMIT 1`,
    [targetAgentId, callerCompanyId],
  );
  const row = rows[0];
  if (!row) return null;
  return { companyId: row.company_id, circleId: row.circle_id };
}

/** Verify the calling agent is a member of the named circle. */
async function isAgentMemberOfCircle(
  agentId: string,
  circleId: string,
): Promise<boolean> {
  if (!dbCtx) return false;
  const rows = await dbCtx.query<{ ok: number }>(
    `SELECT 1::int AS ok
       FROM ${tbl("role_assignments")} ra
       JOIN ${tbl("roles")} r ON r.id = ra.role_id
      WHERE ra.agent_id = $1::uuid AND r.circle_id = $2::uuid
      LIMIT 1`,
    [agentId, circleId],
  );
  return rows.length > 0;
}

/**
 * Load the company id for a circle (used to build event topics when only the
 * circle id is supplied by the caller).
 */
async function resolveCircleCompanyId(circleId: string): Promise<string | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{ company_id: string }>(
    `SELECT company_id FROM ${tbl("circles")} WHERE id = $1::uuid LIMIT 1`,
    [circleId],
  );
  return rows[0]?.company_id ?? null;
}

/**
 * Look up the pending-reply sidecar for an A2A-originated issue. The row
 * carries the Response Topic + Correlation Data + user properties the
 * inbound handler stashed; the reply tool publishes against those exact
 * coordinates so the originator's `publishRequestAwaitReply` resolves.
 */
async function loadPendingReplyForIssueLite(issueId: string): Promise<
  | {
      taskId: string;
      responseTopic: string;
      correlationData: Buffer | null;
      userProperties: Record<string, string>;
    }
  | null
> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{
    task_id: string;
    response_topic: string;
    correlation_data: Buffer | null;
    user_properties: unknown;
  }>(
    `SELECT task_id, response_topic, correlation_data, user_properties
       FROM public.a2a_pending_replies
      WHERE issue_id = $1::uuid
      LIMIT 1`,
    [issueId],
  );
  const row = rows[0];
  if (!row) return null;
  let cd: Buffer | null = null;
  if (row.correlation_data) {
    cd = Buffer.isBuffer(row.correlation_data)
      ? row.correlation_data
      : Buffer.from(row.correlation_data as unknown as Uint8Array);
  }
  const up =
    row.user_properties && typeof row.user_properties === "object"
      ? (row.user_properties as Record<string, string>)
      : {};
  return {
    taskId: row.task_id,
    responseTopic: row.response_topic,
    correlationData: cd,
    userProperties: up,
  };
}

async function loadIssueForReply(
  issueId: string,
  callerAgentId: string,
): Promise<{ id: string; originKind: string; contextId: string | null; assigneeAgentId: string | null } | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{
    id: string;
    origin_kind: string;
    a2a_context_id: string | null;
    assignee_agent_id: string | null;
  }>(
    `SELECT id::text AS id, origin_kind, a2a_context_id, assignee_agent_id::text
       FROM public.issues
      WHERE id = $1::uuid
      LIMIT 1`,
    [issueId],
  );
  const r = rows[0];
  if (!r) return null;
  // Defence in depth — the caller must own the issue.
  if (r.assignee_agent_id && r.assignee_agent_id !== callerAgentId) return null;
  return {
    id: r.id,
    originKind: r.origin_kind,
    contextId: r.a2a_context_id ?? null,
    assigneeAgentId: r.assignee_agent_id,
  };
}

/**
 * Subscribe to a reply topic, publish an A2A Task with Response Topic +
 * Correlation Data, await the first matching reply (matched by correlation
 * data). Returns the parsed reply payload on success or `null` on timeout.
 *
 * Mirrors `publishRequestAwaitReply` from `@paperclipai/adapter-a2a-mqtt` but
 * runs through the plugin SDK so the publish is signed as the calling agent.
 */
async function publishTaskAndAwaitReply(
  runCtx: ToolRunContextLike,
  requestTopicStr: string,
  replyTopicStr: string,
  taskPayload: Record<string, unknown>,
  correlationData: Buffer,
  timeoutMs: number,
): Promise<{ reply: unknown } | null> {
  if (!mqttCtx) return null;

  let resolved = false;
  let resolveFn: (value: { reply: unknown } | null) => void = () => {};

  const result = new Promise<{ reply: unknown } | null>((res) => {
    resolveFn = res;
  });

  const unsubscribe = mqttCtx.on(replyTopicStr, (msg) => {
    if (resolved) return;
    // Match by correlation data when present (defence-in-depth — the topic
    // also includes the taskId, so any mismatch is a publisher mistake).
    if (msg.correlationData && correlationData.length > 0) {
      const eq =
        msg.correlationData.length === correlationData.length &&
        msg.correlationData.equals(correlationData);
      if (!eq) return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.payload.toString("utf8"));
    } catch {
      parsed = msg.payload.toString("utf8");
    }
    resolved = true;
    resolveFn({ reply: parsed });
  });

  // Give the subscribe a tick to land on the broker before publishing.
  await new Promise((res) => setTimeout(res, 25));

  try {
    await mqttCtx.publishAs(runCtx.agentId, requestTopicStr, taskPayload, {
      qos: 1,
      retain: false,
      responseTopic: replyTopicStr,
      correlationData,
      userProperties: { "a2a-source": "holacracy-tool" },
    });
  } catch (err) {
    resolved = true;
    resolveFn(null);
    try {
      await unsubscribe();
    } catch {
      /* noop */
    }
    throw err;
  }

  const timeoutHandle = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    resolveFn(null);
  }, timeoutMs);

  try {
    return await result;
  } finally {
    clearTimeout(timeoutHandle);
    try {
      await unsubscribe();
    } catch {
      /* noop */
    }
  }
}

async function runTalkToAgent(
  params: TalkToAgentParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!mqttCtx) return { content: "MQTT not available", error: "mqtt_unavailable" };
  // Phase 1.15c — cross-talk gate.
  const block = await checkCrossTalkBlock(runCtx.agentId);
  if (block) return { content: block, error: "wait_your_turn" };
  const target = await resolveAgentHomeCircle(runCtx.companyId, params.toAgentId);
  if (!target) {
    return {
      content: `Target agent ${params.toAgentId} has no role assignment in your company`,
      error: "no_target_circle",
    };
  }
  const { requestTopic, replyTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
  const contextId = params.contextId && params.contextId.length > 0 ? params.contextId : randomUUID();
  const taskId = randomUUID();
  const text = params.text;
  const awaitReply = params.awaitReply !== false; // default true
  const timeoutMs = Math.max(1000, Math.min(params.timeoutMs ?? 15000, 120_000));

  const taskPayload = {
    id: taskId,
    kind: "task",
    contextId,
    message: { role: "user", parts: [{ text }] },
  };

  const reqTopic = requestTopic(target.companyId, target.circleId, params.toAgentId);

  if (!awaitReply) {
    try {
      await mqttCtx.publishAs(runCtx.agentId, reqTopic, taskPayload, {
        qos: 1,
        retain: false,
        userProperties: { "a2a-source": "holacracy-tool" },
      });
      return { content: JSON.stringify({ taskId, contextId, awaited: false }, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `publishAs failed: ${msg}`, error: "publish_failed" };
    }
  }

  // Await reply path — the reply topic is keyed by the caller (publisher) so
  // the broker ACL admits both the caller's subscribe and the receiver's
  // publish (per `reply` ACL rule: segments[5] === publisher.agentId).
  const correlationData = Buffer.from(taskId, "utf8");
  // The reply topic format uses the CALLER's identity in the agent slot —
  // matches `paperclip/v1/reply/{c}/{circle}/{agentId}/{taskId}` which both
  // sides agree on by convention.
  const replyTopicStr = replyTopic(runCtx.companyId, target.circleId, runCtx.agentId, taskId);

  const out = await publishTaskAndAwaitReply(
    runCtx,
    reqTopic,
    replyTopicStr,
    taskPayload,
    correlationData,
    timeoutMs,
  );

  if (!out) {
    // Phase 1.15f — record failed exchange.
    try {
      await updateTrustSignal(runCtx.agentId, params.toAgentId, "general", false);
    } catch {
      /* noop */
    }
    return {
      content: JSON.stringify({ taskId, contextId, awaited: true, timedOut: true }, null, 2),
      error: "reply_timeout",
    };
  }
  // Phase 1.15f — record successful exchange.
  try {
    await updateTrustSignal(runCtx.agentId, params.toAgentId, "general", true);
  } catch {
    /* noop */
  }
  return {
    content: JSON.stringify({ taskId, contextId, awaited: true, reply: out.reply }, null, 2),
  };
}

/**
 * Phase 1.15f — Increment a trust signal between two agents on a skill slug.
 * Idempotent UPSERT. `successful=true` increments successful_exchanges;
 * `successful=false` increments failed_exchanges.
 */
async function updateTrustSignal(
  trusterAgentId: string,
  trustedAgentId: string,
  skillSlug: string,
  successful: boolean,
): Promise<void> {
  if (!dbCtx) return;
  await dbCtx.execute(
    `INSERT INTO public.agent_trust_signals
       (truster_agent_id, trusted_agent_id, skill_slug, successful_exchanges, failed_exchanges, last_exchange_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (truster_agent_id, trusted_agent_id, skill_slug) DO UPDATE
       SET successful_exchanges = public.agent_trust_signals.successful_exchanges + EXCLUDED.successful_exchanges,
           failed_exchanges     = public.agent_trust_signals.failed_exchanges    + EXCLUDED.failed_exchanges,
           last_exchange_at     = NOW(),
           updated_at           = NOW()`,
    [
      trusterAgentId,
      trustedAgentId,
      skillSlug,
      successful ? 1 : 0,
      successful ? 0 : 1,
    ],
  );
}

async function runReplyOnTask(
  params: ReplyOnTaskParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!mqttCtx) return { content: "MQTT not available", error: "mqtt_unavailable" };
  const issue = await loadIssueForReply(params.issueId, runCtx.agentId);
  if (!issue) {
    return { content: `Issue ${params.issueId} not found or not yours`, error: "not_found" };
  }
  if (issue.originKind !== "a2a:request") {
    return {
      content: `Issue ${params.issueId} did not originate from A2A (origin_kind=${issue.originKind})`,
      error: "wrong_origin",
    };
  }
  const pending = await loadPendingReplyForIssueLite(params.issueId);
  if (!pending) {
    return {
      content: `No pending A2A reply row for issue ${params.issueId} — the bridge may have already replied`,
      error: "no_pending_reply",
    };
  }
  const stateMap: Record<ReplyOnTaskParams["state"], string> = {
    completed: "TASK_STATE_COMPLETED",
    input_required: "TASK_STATE_INPUT_REQUIRED",
    failed: "TASK_STATE_FAILED",
  };
  const replyPayload: Record<string, unknown> = {
    id: pending.taskId,
    status: { state: stateMap[params.state] },
    ...(issue.contextId ? { contextId: issue.contextId } : {}),
  };
  if (params.state === "completed") {
    replyPayload.artifacts = params.artifacts ?? [
      {
        messageId: randomUUID(),
        parts: [{ text: params.text ?? "Done" }],
      },
    ];
  } else {
    replyPayload.message = { parts: [{ text: params.text ?? "" }] };
  }

  try {
    await mqttCtx.publishAs(runCtx.agentId, pending.responseTopic, replyPayload, {
      qos: 1,
      retain: false,
      correlationData: pending.correlationData ?? undefined,
      userProperties: {
        ...pending.userProperties,
        "a2a-status-source": "agent-tool",
        ...(issue.contextId ? { "a2a-task-context-id": issue.contextId, "a2a-context-id": issue.contextId } : {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `publishAs failed: ${msg}`, error: "publish_failed" };
  }

  return {
    content: JSON.stringify(
      {
        issueId: params.issueId,
        taskId: pending.taskId,
        contextId: issue.contextId,
        state: params.state,
        responseTopic: pending.responseTopic,
      },
      null,
      2,
    ),
  };
}

async function runBroadcastToCircle(
  params: BroadcastToCircleParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!mqttCtx) return { content: "MQTT not available", error: "mqtt_unavailable" };
  // Phase 1.15c — cross-talk gate.
  const block = await checkCrossTalkBlock(runCtx.agentId);
  if (block) return { content: block, error: "wait_your_turn" };
  const memberOk = await isAgentMemberOfCircle(runCtx.agentId, params.circleId);
  if (!memberOk) {
    return {
      content: `Agent ${runCtx.agentId} is not a member of circle ${params.circleId}`,
      error: "not_a_member",
    };
  }
  const companyId = await resolveCircleCompanyId(params.circleId);
  if (!companyId) {
    return { content: `Circle ${params.circleId} not found`, error: "circle_not_found" };
  }
  const { hostEventTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
  // Agents cannot publish to the `announce` event sub-channel per ACL — the
  // host publishes on their behalf and stamps the publisher identity in MQTT
  // v5 user properties so receivers know who said it.
  const topic = hostEventTopic(companyId, params.circleId, "announce");
  const payload = {
    kind: params.kind,
    body: params.body,
    publisherAgentId: runCtx.agentId,
    publishedAt: new Date().toISOString(),
  };
  try {
    await mqttCtx.publish(topic, payload, {
      qos: 1,
      retain: false,
      userProperties: {
        "paperclip-publisher-agent-id": runCtx.agentId,
        "paperclip-broadcast-kind": params.kind,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `publish failed: ${msg}`, error: "publish_failed" };
  }
  return { content: JSON.stringify({ topic, publisherAgentId: runCtx.agentId, kind: params.kind }, null, 2) };
}

async function runRaiseTensionOnBus(
  params: RaiseTensionOnBusParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!mqttCtx) return { content: "MQTT not available", error: "mqtt_unavailable" };
  if (!dbCtx) return { content: "DB not available", error: "db_unavailable" };
  const memberOk = await isAgentMemberOfCircle(runCtx.agentId, params.circleId);
  if (!memberOk) {
    return {
      content: `Agent ${runCtx.agentId} is not a member of circle ${params.circleId}`,
      error: "not_a_member",
    };
  }
  const companyId = await resolveCircleCompanyId(params.circleId);
  if (!companyId) {
    return { content: `Circle ${params.circleId} not found`, error: "circle_not_found" };
  }
  // Persist the tension via the same SQL the in-process raise-tension tool uses.
  const tensionId = randomUUID();
  await dbCtx.execute(
    `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, 'operational')`,
    [tensionId, params.circleId, runCtx.agentId, params.title, params.body],
  );
  await dbCtx.execute(
    `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
    [
      companyId,
      runCtx.agentId,
      params.circleId,
      JSON.stringify({ tensionId, title: params.title, severity: params.severity ?? "medium", surface: "a2a-bus" }),
    ],
  );

  // Publish on the circle's tension-raised event topic. Per ACL extension,
  // any circle member may publish to this sub-channel.
  const { hostEventTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
  const topic = hostEventTopic(companyId, params.circleId, "tension-raised");
  const payload = {
    kind: "tension.raised",
    tensionId,
    circleId: params.circleId,
    title: params.title,
    body: params.body,
    severity: params.severity ?? "medium",
    sourceAgentId: runCtx.agentId,
    raisedAt: new Date().toISOString(),
  };
  try {
    await mqttCtx.publishAs(runCtx.agentId, topic, payload, {
      qos: 1,
      retain: false,
      userProperties: {
        "paperclip-publisher-agent-id": runCtx.agentId,
        "paperclip-tension-id": tensionId,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The DB write succeeded — return success but flag the publish failure
    // so the caller knows the bus didn't see it.
    return {
      content: JSON.stringify({ tensionId, busPublished: false, publishError: msg }, null, 2),
    };
  }
  return {
    content: JSON.stringify({ tensionId, topic, busPublished: true }, null, 2),
  };
}

async function runAskSkill(
  params: AskSkillParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!mqttCtx) return { content: "MQTT not available", error: "mqtt_unavailable" };
  const { skillPoolTopic, replyTopic, slugify } = await import("@paperclipai/adapter-a2a-mqtt/server");
  const slug = slugify(params.skill);
  if (slug.length === 0) {
    return { content: `Skill name "${params.skill}" slugifies to empty`, error: "bad_skill" };
  }
  const topic = skillPoolTopic(runCtx.companyId, slug);
  const contextId = params.contextId && params.contextId.length > 0 ? params.contextId : randomUUID();
  const taskId = randomUUID();
  const awaitReply = params.awaitReply !== false; // default true
  const timeoutMs = Math.max(1000, Math.min(params.timeoutMs ?? 15000, 120_000));

  const taskPayload = {
    id: taskId,
    kind: "task",
    contextId,
    message: { role: "user", parts: [{ text: params.text }] },
  };

  if (!awaitReply) {
    try {
      await mqttCtx.publishAs(runCtx.agentId, topic, taskPayload, {
        qos: 1,
        retain: false,
        userProperties: { "a2a-source": "holacracy-tool", "a2a-skill-slug": slug },
      });
      return { content: JSON.stringify({ taskId, contextId, slug, awaited: false }, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `publishAs failed: ${msg}`, error: "publish_failed" };
    }
  }

  // Reply topic — the caller still owns the reply destination. Use the
  // caller's own circle slot (any circle they're in) so the ACL admits it.
  // For skill bus we need to pick a circle of the caller; fall back to a
  // placeholder if the caller holds no circle (rare but possible). The
  // listener publishes the reply on this exact topic.
  const home = await resolveAgentHomeCircle(runCtx.companyId, runCtx.agentId);
  if (!home) {
    return {
      content: `Caller ${runCtx.agentId} has no circle assignment — cannot await reply on skill bus`,
      error: "no_caller_circle",
    };
  }
  const correlationData = Buffer.from(taskId, "utf8");
  const replyTopicStr = replyTopic(runCtx.companyId, home.circleId, runCtx.agentId, taskId);

  const out = await publishTaskAndAwaitReply(
    runCtx,
    topic,
    replyTopicStr,
    taskPayload,
    correlationData,
    timeoutMs,
  );

  if (!out) {
    return {
      content: JSON.stringify({ taskId, contextId, slug, awaited: true, timedOut: true }, null, 2),
      error: "reply_timeout",
    };
  }
  return {
    content: JSON.stringify({ taskId, contextId, slug, awaited: true, reply: out.reply }, null, 2),
  };
}

// ─── Phase 1.14 — Circle Discussions ───────────────────────────────────────
//
// A circle discussion composes the Phase 1.13 primitives (a2a_context_id
// threading, neighbourhood snapshot, issue lifecycle) into the first real
// multi-agent conversation pattern: drop a statement onto a circle, every
// member contributes (one issue per round), and either (a) more rounds run,
// or (b) the Secretary role-holder summarises and the discussion concludes.
//
// The discussion table lives in `public.circle_discussions` (it references
// public.companies + public.agents). Per-turn issues live in `public.issues`
// with origin_kind='discussion:turn', origin_id=<discussion.id>, and the
// shared a2a_context_id. Round numbers are stored on
// `issues.origin_fingerprint` as 'round-N' (string text, indexed alongside
// origin_kind+origin_id) — this avoids needing a new column on issues.

interface CircleDiscussionRow {
  id: string;
  company_id: string;
  circle_id: string | null;
  a2a_context_id: string;
  topic: string;
  prompt_for_agents: string | null;
  initiated_by_agent_id: string | null;
  initiated_by_user_id: string | null;
  participant_agent_ids: string[];
  status: string;
  rounds_planned: number;
  rounds_completed: number;
  conclusion: string | null;
  conclusion_kind: string | null;
  started_at: string;
  concluded_at: string | null;
  metadata: Record<string, unknown> | null;
  /** Phase 1.15c — speaker mode.
   *  'psych_safety' (alias: legacy 'reverse-priority') | 'roundtable' |
   *  'parallel' | 'call-out'. Phase 1.15h-i renamed `reverse-priority` →
   *  `psych_safety` (Lead Link last is a Grove/psych-safety overlay, not
   *  Holacracy doctrine — Robertson treats reactions as symmetric). Both
   *  values still work as input; storage prefers `psych_safety`. */
  speaker_mode: string;
  current_speaker_idx: number;
  /** Phase 1.15c — pre-computed ordering (uuid[]) when not parallel. Empty
   *  when mode='parallel' (we ignore order). */
  speaker_order: string[];
  /** Phase 1.15e — 'open' | 'awaiting_commitments' | 'concluded'. */
  phase: string;
  required_commitment_threshold: number;
  /** Phase 1.15h-h1 — SMART fields. */
  success_criterion: string | null;
  scope_in: string[] | null;
  scope_out: string[] | null;
  decision_deadline: string | null;
  motivating_tension_id: string | null;
  expected_output_kind: string | null;
  /** Phase 1.15h-i #9 — set by `bridgeDiscussionToIdm` when objections were
   *  raised in the commit-to-support phase. Soft pointer to `idm_approvals.id`. */
  idm_approval_id: string | null;
  /** Phase 1.15h-i #2 — Grove pre-flight (High Output Management ch. 5). */
  decision_owner_agent_id: string | null;
  consulted_agent_ids: string[] | null;
  ratifier_agent_id: string | null;
  informed_agent_ids: string[] | null;
  /** Phase 1.15h-l F3 — IDM integration ⇄ objections cycle counter.
   *  Migration 0091 adds the column with default 0. */
  integration_cycles_count: number;
}

const DISCUSSION_TURN_ORIGIN_KIND = "discussion:turn";
const DISCUSSION_SUMMARY_ORIGIN_KIND = "discussion:summary";
const DISCUSSION_TITLE_MAX = 250;

function discussionFingerprint(round: number, isSummary = false): string {
  return isSummary ? "summary" : `round-${round}`;
}

function defaultRoundPrompt(): string {
  return "Share your view on this in 1-2 paragraphs. Build on, agree with, or counter the views of others if you've seen them.";
}

/**
 * Resolve `(companyId, projectId)` for a circle so the per-turn issues link
 * back to the right project (Paperclip's project = circle mapping).
 */
async function resolveCircleProject(
  circleId: string,
): Promise<{ companyId: string; projectId: string | null } | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{ company_id: string; project_id: string | null }>(
    `SELECT company_id, project_id FROM ${tbl("circles")} WHERE id = $1`,
    [circleId],
  );
  if (rows.length === 0) return null;
  return { companyId: rows[0].company_id, projectId: rows[0].project_id };
}

/**
 * Pull every distinct agent currently assigned to any role within the circle.
 * Returns deduped, non-null agent ids.
 */
async function resolveCircleParticipantAgentIds(circleId: string): Promise<string[]> {
  if (!dbCtx) return [];
  const rows = await dbCtx.query<{ agent_id: string }>(
    `SELECT DISTINCT ra.agent_id
       FROM ${tbl("role_assignments")} ra
       JOIN ${tbl("roles")} r ON r.id = ra.role_id
      WHERE r.circle_id = $1 AND ra.agent_id IS NOT NULL`,
    [circleId],
  );
  return rows.map((r) => r.agent_id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Find the agent currently holding the Secretary role in a circle.
 * Falls back to null when no Secretary is assigned.
 */
async function resolveCircleSecretaryAgentId(circleId: string): Promise<string | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{ agent_id: string | null }>(
    `SELECT ra.agent_id
       FROM ${tbl("roles")} r
       LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id
      WHERE r.circle_id = $1 AND r.role_type = 'secretary'
      LIMIT 1`,
    [circleId],
  );
  return rows[0]?.agent_id ?? null;
}

/**
 * Read the "content" for a finished discussion turn. Order of preference:
 *   1. Most recent comment on the issue (the typical completion vehicle).
 *   2. The issue's description (fallback when no comments exist — useful for
 *      demos where the script just sets status=done without inserting a
 *      comment).
 * Returns null when neither is available.
 */
async function readTurnContent(issueId: string): Promise<string | null> {
  if (!dbCtx) return null;
  const comments = await dbCtx.query<{ body: string }>(
    `SELECT body FROM public.issue_comments WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [issueId],
  );
  if (comments.length > 0 && typeof comments[0].body === "string" && comments[0].body.trim().length > 0) {
    return comments[0].body;
  }
  const issue = await dbCtx.query<{ description: string | null }>(
    `SELECT description FROM public.issues WHERE id = $1`,
    [issueId],
  );
  return issue[0]?.description ?? null;
}

interface DiscussionTurnSummary {
  issueId: string;
  agentId: string | null;
  agentName: string | null;
  roundNumber: number; // 0 for summary
  isSummary: boolean;
  status: string;
  content: string | null;
  completedAt: string | null;
  createdAt: string;
}

async function loadDiscussionTurns(discussionId: string): Promise<DiscussionTurnSummary[]> {
  if (!dbCtx) return [];
  interface Row {
    id: string;
    assignee_agent_id: string | null;
    agent_name: string | null;
    origin_kind: string;
    origin_fingerprint: string;
    status: string;
    description: string | null;
    completed_at: string | null;
    created_at: string;
  }
  const rows = await dbCtx.query<Row>(
    `SELECT i.id,
            i.assignee_agent_id,
            a.name AS agent_name,
            i.origin_kind,
            i.origin_fingerprint,
            i.status,
            i.description,
            i.completed_at::text AS completed_at,
            i.created_at::text AS created_at
       FROM public.issues i
       LEFT JOIN public.agents a ON a.id = i.assignee_agent_id
      WHERE i.origin_id = $1
        AND i.origin_kind IN ($2, $3)
      ORDER BY i.origin_fingerprint ASC, i.created_at ASC`,
    [discussionId, DISCUSSION_TURN_ORIGIN_KIND, DISCUSSION_SUMMARY_ORIGIN_KIND],
  );
  const out: DiscussionTurnSummary[] = [];
  for (const r of rows) {
    const isSummary = r.origin_kind === DISCUSSION_SUMMARY_ORIGIN_KIND;
    const roundMatch = /^round-(\d+)$/i.exec(r.origin_fingerprint ?? "");
    const roundNumber = isSummary ? 0 : roundMatch ? parseInt(roundMatch[1], 10) : 0;
    const content = await readTurnContent(r.id);
    out.push({
      issueId: r.id,
      agentId: r.assignee_agent_id,
      agentName: r.agent_name,
      roundNumber,
      isSummary,
      status: r.status,
      content,
      completedAt: r.completed_at,
      createdAt: r.created_at,
    });
  }
  return out;
}

/**
 * Render a digest of previous-round turn content to embed in the next round's
 * issue description. Bounded so we don't blow the token budget.
 */
function renderRoundDigest(
  turns: DiscussionTurnSummary[],
  uptoRound: number,
): string {
  const lines: string[] = [];
  for (let round = 1; round <= uptoRound; round += 1) {
    const roundTurns = turns.filter((t) => !t.isSummary && t.roundNumber === round && t.status === "done");
    if (roundTurns.length === 0) continue;
    lines.push(`### Round ${round} contributions`);
    for (const t of roundTurns) {
      const name = t.agentName ?? (t.agentId ? t.agentId.slice(0, 8) : "unknown");
      const content = (t.content ?? "(no content)").slice(0, 800);
      lines.push(`**${name}**: ${content}`);
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}

interface SpawnTurnArgs {
  discussion: CircleDiscussionRow;
  roundNumber: number;
  digest: string | null;
  /** When non-empty, restrict spawn to these agents only (used by
   *  reverse-priority/roundtable to spawn one at a time). */
  onlyAgents?: string[];
  /** Phase 1.15h-l F3 — Optional override for the issue's `origin_fingerprint`.
   *  IDM phase turns use `idm-<phase>` (and `idm-<phase>-c<n>` for
   *  integration/objections cycles) instead of `round-N`. When omitted, falls
   *  back to `round-{roundNumber}` so legacy callers are unaffected. */
  fingerprintOverride?: string;
  /** Phase 1.15h-l F3 — Optional extra prompt text appended to the issue
   *  description, used to surface IDM phase-specific instructions. */
  extraPrompt?: string;
}

/**
 * Compute the speaker order for a discussion based on its `speaker_mode`.
 * - `parallel`: returns the participant list as-is.
 * - `psych_safety` (alias: `reverse-priority`): Lead Link of the circle goes
 *   LAST; remaining members are alphabetical by id (deterministic). Falls back
 *   to the participant order if there's no circle (1:1). Lead-Link-last is a
 *   Grove/psych-safety overlay so the highest-status voice doesn't anchor the
 *   reactions round — not Holacracy doctrine.
 * - `roundtable`: alphabetical by id.
 * - `call-out`: not supported here — fall back to participant list.
 */
async function computeSpeakerOrder(
  discussion: CircleDiscussionRow,
): Promise<string[]> {
  if (!dbCtx) return discussion.participant_agent_ids;
  const mode = discussion.speaker_mode ?? "psych_safety";
  if (mode === "parallel") return discussion.participant_agent_ids;
  if (mode === "psych_safety" || mode === "reverse-priority") {
    // Find the Lead Link of the circle; place last.
    let leadLinkAgentId: string | null = null;
    if (discussion.circle_id) {
      try {
        const rows = await dbCtx.query<{ agent_id: string }>(
          `SELECT ra.agent_id
             FROM ${tbl("roles")} r
             JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id
            WHERE r.circle_id = $1 AND r.role_type = 'circle_lead'
            LIMIT 1`,
          [discussion.circle_id],
        );
        leadLinkAgentId = rows[0]?.agent_id ?? null;
      } catch {
        leadLinkAgentId = null;
      }
    }
    const rest = discussion.participant_agent_ids
      .filter((id) => id !== leadLinkAgentId)
      .sort();
    return leadLinkAgentId && discussion.participant_agent_ids.includes(leadLinkAgentId)
      ? [...rest, leadLinkAgentId]
      : rest;
  }
  if (mode === "roundtable") return [...discussion.participant_agent_ids].sort();
  return discussion.participant_agent_ids;
}

async function spawnRoundTurnIssues(args: SpawnTurnArgs): Promise<string[]> {
  if (!dbCtx) throw new Error("DB not initialized");
  const { discussion, roundNumber, digest, onlyAgents, fingerprintOverride, extraPrompt } = args;
  
  // MYA-175: Guard against empty topic payloads (race between discussion creation
  // and snapshot assembly can result in agents woken with no active discussions).
  if (!discussion.topic || discussion.topic.trim().length === 0) {
    const msg = `Discussion ${discussion.id} spawn-round guard: empty topic rejected`;
    console.error(`[holacracy] MYA-175: ${msg}`);
    if (activityCtx) {
      try {
        await activityCtx.log({
          kind: "holacracy-issue",
          action: "empty-round-spawn-guard-triggered",
          entityId: discussion.id,
          detail: `Round ${roundNumber} rejected due to empty topic`,
          severity: "warning",
        });
      } catch (_err) {
        // ignore logging failure
      }
    }
    throw new Error(msg);
  }
  
  const projectInfo = discussion.circle_id ? await resolveCircleProject(discussion.circle_id) : null;
  const projectId = projectInfo?.projectId ?? null;
  const titleSrc = `[Discussion] ${discussion.topic}`;
  const title = titleSrc.length > DISCUSSION_TITLE_MAX ? `${titleSrc.slice(0, DISCUSSION_TITLE_MAX - 1)}…` : titleSrc;
  const promptText = discussion.prompt_for_agents && discussion.prompt_for_agents.trim().length > 0
    ? discussion.prompt_for_agents
    : defaultRoundPrompt();
  const created: string[] = [];
  const fingerprint = fingerprintOverride && fingerprintOverride.length > 0
    ? fingerprintOverride
    : discussionFingerprint(roundNumber);
  const targetAgents = onlyAgents && onlyAgents.length > 0
    ? onlyAgents
    : discussion.participant_agent_ids;
  for (const agentId of targetAgents) {
    // Idempotency: skip if an issue already exists for this (discussion, round, agent).
    const existing = await dbCtx.query<{ id: string }>(
      `SELECT id FROM public.issues
         WHERE origin_kind = $1 AND origin_id = $2 AND origin_fingerprint = $3 AND assignee_agent_id = $4
         LIMIT 1`,
      [DISCUSSION_TURN_ORIGIN_KIND, discussion.id, fingerprint, agentId],
    );
    if (existing.length > 0) {
      created.push(existing[0].id);
      continue;
    }
    const description = [
      discussion.topic,
      "",
      promptText,
      ...(extraPrompt ? ["", extraPrompt] : []),
      "",
      `(Round ${roundNumber} of ${discussion.rounds_planned} — this is your turn.)`,
      ...(digest ? ["", "## Prior rounds in this discussion", "", digest] : []),
    ].join("\n");
    const id = randomUUID();
    await dbCtx.execute(
      `INSERT INTO public.issues
         (id, company_id, project_id, title, description, status, kind, priority,
          assignee_agent_id, origin_kind, origin_id, origin_fingerprint,
          a2a_context_id)
       VALUES ($1, $2, $3, $4, $5, 'backlog', 'next_action', 'medium', $6, $7, $8, $9, $10)`,
      [
        id,
        discussion.company_id,
        projectId,
        title,
        description,
        agentId,
        DISCUSSION_TURN_ORIGIN_KIND,
        discussion.id,
        fingerprint,
        discussion.a2a_context_id,
      ],
    );
    created.push(id);

    // Phase 1.15a — publish a discussion-opened event on the MQTT discussion topic
    // so other participants get a wake-eligible perception. Best-effort; never
    // fails the spawn.
    try {
      await publishDiscussionEvent(discussion, {
        kind: "discussion-turn-spawned",
        round: roundNumber,
        agentId,
        issueId: id,
      });
    } catch (_err) {
      // ignore — DB write succeeded
    }
  }
  return created;
}

/**
 * Phase 1.15a — Publish on the MQTT discussion topic
 * `paperclip/v1/discussion/{companyId}/{contextId}`. The host singleton
 * publishes (broker grants superuser); receivers' per-agent clients have
 * been granted SUBSCRIBE for this topic by `subscription-compute.ts` +
 * `acl-backend.ts` extensions.
 */
async function publishDiscussionEvent(
  discussion: CircleDiscussionRow,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!mqttCtx) return;
  const topic = `paperclip/v1/discussion/${discussion.company_id}/${discussion.a2a_context_id}`;
  try {
    await mqttCtx.publish(topic, {
      ...payload,
      discussionId: discussion.id,
      contextId: discussion.a2a_context_id,
      at: new Date().toISOString(),
    }, {
      qos: 1,
      retain: false,
      userProperties: {
        "paperclip-discussion-id": discussion.id,
        "paperclip-discussion-event": String(payload.kind ?? "discussion-event"),
      },
    });
  } catch (_err) {
    // best-effort
  }
}

async function spawnSummariserIssue(
  discussion: CircleDiscussionRow,
  turns: DiscussionTurnSummary[],
): Promise<string | null> {
  if (!dbCtx) return null;
  // Skip if a summariser already exists (idempotent).
  const existing = await dbCtx.query<{ id: string }>(
    `SELECT id FROM public.issues
       WHERE origin_kind = $1 AND origin_id = $2 AND origin_fingerprint = 'summary'
       LIMIT 1`,
    [DISCUSSION_SUMMARY_ORIGIN_KIND, discussion.id],
  );
  if (existing.length > 0) return existing[0].id;

  const secretaryAgentId = (discussion.circle_id ? await resolveCircleSecretaryAgentId(discussion.circle_id) : null)
    ?? discussion.initiated_by_agent_id
    ?? discussion.participant_agent_ids[0]
    ?? null;
  if (!secretaryAgentId) return null;

  const projectInfo = discussion.circle_id ? await resolveCircleProject(discussion.circle_id) : null;
  const projectId = projectInfo?.projectId ?? null;
  const digest = renderRoundDigest(turns, discussion.rounds_planned);
  const titleSrc = `[Discussion-Summary] ${discussion.topic}`;
  const title = titleSrc.length > DISCUSSION_TITLE_MAX ? `${titleSrc.slice(0, DISCUSSION_TITLE_MAX - 1)}…` : titleSrc;
  const description = [
    `# Summarise this discussion`,
    "",
    `**Topic**: ${discussion.topic}`,
    "",
    `${discussion.participant_agent_ids.length} agents contributed across ${discussion.rounds_planned} round(s).`,
    "",
    "## Full transcript",
    "",
    digest || "(no contributions)",
    "",
    "## Your task",
    "",
    "Summarise the discussion in 3-5 bullets. Identify any agreement, open question, tension to raise, or next action. Output as JSON:",
    "",
    "```json",
    '{ "summary": "...", "kind": "agreement|policy|tension|next-action|note", "suggestedFollowups": [] }',
    "```",
    "",
    "If you cannot produce valid JSON, write your summary as plain text — the scheduler will store it raw.",
  ].join("\n");
  const id = randomUUID();
  await dbCtx.execute(
    `INSERT INTO public.issues
       (id, company_id, project_id, title, description, status, kind, priority,
        assignee_agent_id, origin_kind, origin_id, origin_fingerprint,
        a2a_context_id)
     VALUES ($1, $2, $3, $4, $5, 'backlog', 'next_action', 'high', $6, $7, $8, 'summary', $9)`,
    [
      id,
      discussion.company_id,
      projectId,
      title,
      description,
      secretaryAgentId,
      DISCUSSION_SUMMARY_ORIGIN_KIND,
      discussion.id,
      discussion.a2a_context_id,
    ],
  );
  return id;
}

interface CreateDiscussionInput {
  circleId: string | null;
  topic: string;
  prompt?: string;
  rounds?: number;
  companyId: string;
  initiatedByAgentId?: string | null;
  initiatedByUserId?: string | null;
  /** Phase 1.15c — 'psych_safety' (default; alias: 'reverse-priority'),
   *  'roundtable', 'parallel', or 'call-out'. */
  speakerMode?: string;
  /** Phase 1.15g — 1:1 / cross-circle: explicit participants override circle membership. */
  participantAgentIds?: string[];
  /** Phase 1.15h-h1 — SMART fields. Surface to the agent preamble so the
   *  discussion has a clear convergence target. All optional; when absent the
   *  preamble falls back to the generic reactions-round instructions. */
  successCriterion?: string;
  scopeIn?: string[];
  scopeOut?: string[];
  decisionDeadline?: string | Date;
  motivatingTensionId?: string;
  expectedOutputKind?: string;
  /** Phase 1.15h-i #2 — Grove pre-flight questions (High Output Management
   *  ch. 5). WHO DECIDES / WHO IS CONSULTED / WHO RATIFIES / WHO IS INFORMED.
   *  All optional; the steward calls the ratifier on a 60-min stall when set. */
  decisionOwnerAgentId?: string | null;
  consultedAgentIds?: string[];
  ratifierAgentId?: string | null;
  informedAgentIds?: string[];
}

async function createDiscussion(
  input: CreateDiscussionInput,
): Promise<
  | { ok: true; discussion: CircleDiscussionRow; issueIds: string[] }
  | { ok: false; status: number; error: string }
> {
  if (!dbCtx) throw new Error("DB not initialized");
  const topic = (input.topic ?? "").trim();
  if (topic.length === 0) return { ok: false, status: 400, error: "topic is required" };
  const rounds = Math.max(1, Math.min(input.rounds ?? 1, 5));
  // Phase 1.15h-i — accept `psych_safety` (new label) and `reverse-priority`
  // (legacy alias) as the same Grove/psych-safety overlay; normalise to
  // `psych_safety` for storage. Default is `psych_safety` (was
  // `reverse-priority`).
  const rawSpeakerMode = (input.speakerMode ?? "psych_safety").toLowerCase();
  const speakerMode = rawSpeakerMode === "reverse-priority" ? "psych_safety" : rawSpeakerMode;
  const allowedModes = new Set(["psych_safety", "roundtable", "parallel", "call-out"]);
  if (!allowedModes.has(speakerMode)) {
    return { ok: false, status: 400, error: `Unknown speaker_mode '${rawSpeakerMode}'` };
  }

  let participants: string[];
  if (input.participantAgentIds && input.participantAgentIds.length > 0) {
    participants = [...new Set(input.participantAgentIds)];
  } else {
    if (!input.circleId) {
      return { ok: false, status: 400, error: "circleId or participantAgentIds is required" };
    }
    const projectInfo = await resolveCircleProject(input.circleId);
    if (!projectInfo) return { ok: false, status: 404, error: "Circle not found" };
    participants = await resolveCircleParticipantAgentIds(input.circleId);
  }
  if (participants.length === 0) {
    return { ok: false, status: 400, error: "Discussion needs at least one participant" };
  }

  const id = randomUUID();
  const contextId = randomUUID();

  // Compute speaker_order based on mode + circle Lead Link.
  // Phase 1.15h-h1 — normalise SMART fields up-front.
  const successCriterion =
    typeof input.successCriterion === "string" && input.successCriterion.trim().length > 0
      ? input.successCriterion.trim()
      : null;
  const scopeIn: string[] = Array.isArray(input.scopeIn)
    ? input.scopeIn.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const scopeOut: string[] = Array.isArray(input.scopeOut)
    ? input.scopeOut.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const decisionDeadlineIso: string | null = input.decisionDeadline
    ? (input.decisionDeadline instanceof Date
        ? input.decisionDeadline.toISOString()
        : new Date(input.decisionDeadline).toISOString())
    : null;
  const motivatingTensionId =
    typeof input.motivatingTensionId === "string" && UUID_RE.test(input.motivatingTensionId)
      ? input.motivatingTensionId
      : null;
  const expectedOutputKind =
    typeof input.expectedOutputKind === "string" && input.expectedOutputKind.trim().length > 0
      ? input.expectedOutputKind.trim()
      : null;

  // Phase 1.15h-i #2 — normalise Grove pre-flight fields. Each agent id must
  // be a UUID; bad values silently drop so partial input still creates the
  // discussion. Lists default to empty (PG TEXT[] / uuid[]).
  const normaliseAgentId = (v: unknown): string | null =>
    typeof v === "string" && UUID_RE.test(v) ? v : null;
  const normaliseAgentIdList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => normaliseAgentId(x)).filter((x): x is string => x !== null)
      : [];
  const decisionOwnerAgentId = normaliseAgentId(input.decisionOwnerAgentId);
  const consultedAgentIds = normaliseAgentIdList(input.consultedAgentIds);
  const ratifierAgentId = normaliseAgentId(input.ratifierAgentId);
  const informedAgentIds = normaliseAgentIdList(input.informedAgentIds);

  const tempForOrder: CircleDiscussionRow = {
    id,
    company_id: input.companyId,
    circle_id: input.circleId,
    a2a_context_id: contextId,
    topic,
    prompt_for_agents: input.prompt ?? null,
    initiated_by_agent_id: input.initiatedByAgentId ?? null,
    initiated_by_user_id: input.initiatedByUserId ?? null,
    participant_agent_ids: participants,
    status: "open",
    rounds_planned: rounds,
    rounds_completed: 0,
    conclusion: null,
    conclusion_kind: null,
    started_at: new Date().toISOString(),
    concluded_at: null,
    metadata: null,
    speaker_mode: speakerMode,
    current_speaker_idx: 0,
    speaker_order: [],
    phase: "open",
    required_commitment_threshold: 0.8,
    success_criterion: successCriterion,
    scope_in: scopeIn,
    scope_out: scopeOut,
    decision_deadline: decisionDeadlineIso,
    motivating_tension_id: motivatingTensionId,
    expected_output_kind: expectedOutputKind,
    idm_approval_id: null,
    decision_owner_agent_id: decisionOwnerAgentId,
    consulted_agent_ids: consultedAgentIds,
    ratifier_agent_id: ratifierAgentId,
    informed_agent_ids: informedAgentIds,
    integration_cycles_count: 0,
  };
  const speakerOrder = await computeSpeakerOrder(tempForOrder);

  const toPgArr = (a: string[]) => `{${a.join(",")}}`;
  await dbCtx.execute(
    `INSERT INTO public.circle_discussions
       (id, company_id, circle_id, a2a_context_id, topic, prompt_for_agents,
        initiated_by_agent_id, initiated_by_user_id, participant_agent_ids,
        status, rounds_planned, rounds_completed, metadata,
        speaker_mode, current_speaker_idx, speaker_order, phase,
        required_commitment_threshold,
        success_criterion, scope_in, scope_out, decision_deadline,
        motivating_tension_id, expected_output_kind,
        decision_owner_agent_id, consulted_agent_ids,
        ratifier_agent_id, informed_agent_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], 'open', $10, 0, $11::jsonb,
             $12, 0, $13::uuid[], 'open', 0.8,
             $14, $15::jsonb, $16::jsonb, $17, $18, $19,
             $20, $21::uuid[], $22, $23::uuid[])`,
    [
      id,
      input.companyId,
      input.circleId,
      contextId,
      topic,
      input.prompt ?? null,
      input.initiatedByAgentId ?? null,
      input.initiatedByUserId ?? null,
      toPgArr(participants),
      rounds,
      JSON.stringify({ source: "api" }),
      speakerMode,
      toPgArr(speakerOrder),
      successCriterion,
      JSON.stringify(scopeIn),
      JSON.stringify(scopeOut),
      decisionDeadlineIso,
      motivatingTensionId,
      expectedOutputKind,
      decisionOwnerAgentId,
      toPgArr(consultedAgentIds),
      ratifierAgentId,
      toPgArr(informedAgentIds),
    ],
  );
  const rows = await dbCtx.query<CircleDiscussionRow>(
    `SELECT * FROM public.circle_discussions WHERE id = $1`,
    [id],
  );
  const discussion = rows[0];

  // Phase 1.15h-f — Force per-agent MQTT subscription recompute for every
  // participant BEFORE spawning turn issues or publishing the
  // discussion-opened event, so the per-agent clients are subscribed to the
  // new `paperclip/v1/discussion/{c}/{contextId}` topic in time to receive
  // those events as perceptions. Without this ordering, the discussion-opened
  // and discussion-turn-spawned events fly out before subscribers are bound
  // → no perceptions → `wakeOnDiscussionPerceptions` never fires →
  // hermes never wakes on this discussion. Best-effort: failures here don't
  // roll back the discussion creation.
  if (mqttCtx) {
    for (const agentId of participants) {
      try {
        await mqttCtx.reconcileAgent(agentId);
      } catch (err) {
        console.warn(
          "[holacracy] mqtt.reconcileAgent failed for",
          agentId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // Phase 1.15h-l F11 — SMART discussions are owned by the IDM advancer
  // (advanceIdmPhase walks open → proposal → clarifying_questions → ...).
  // The legacy round-1 spawn here would race the IDM `idm-proposal` turn
  // and assign work to ALL participants instead of just the proposer,
  // producing duplicate / wasted Bedrock spawns. Skip the legacy spawn
  // for SMART; the F3 advancer's `open → proposal` transition (firing on
  // the next cron tick) will spawn the correct single-proposer turn.
  let issueIds: string[];
  const isSmart =
    typeof successCriterion === "string" && successCriterion.trim().length > 0;
  if (isSmart) {
    issueIds = [];
  } else if (speakerMode === "parallel") {
    issueIds = await spawnRoundTurnIssues({ discussion, roundNumber: 1, digest: null });
  } else {
    // Sequential — spawn just the first speaker.
    const firstAgent = (discussion.speaker_order && discussion.speaker_order.length > 0)
      ? discussion.speaker_order[0]
      : discussion.participant_agent_ids[0];
    issueIds = await spawnRoundTurnIssues({
      discussion,
      roundNumber: 1,
      digest: null,
      onlyAgents: [firstAgent],
    });
  }

  // Publish a discussion-opened MQTT event.
  try {
    await publishDiscussionEvent(discussion, {
      kind: "discussion-opened",
      topic,
      participantAgentIds: participants,
      speakerMode,
      roundsPlanned: rounds,
      speakerOrder,
    });
  } catch {
    /* noop */
  }

  // Legacy block below retained for safety: re-reconcile post-publish in case
  // a race left a participant unsubscribed. No-op when already subscribed.
  if (mqttCtx) {
    for (const agentId of participants) {
      try {
        await mqttCtx.reconcileAgent(agentId);
      } catch (err) {
        console.warn(
          "[holacracy] mqtt.reconcileAgent (post) failed for",
          agentId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return { ok: true, discussion, issueIds };
}

async function loadDiscussion(discussionId: string): Promise<CircleDiscussionRow | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<CircleDiscussionRow>(
    `SELECT * FROM public.circle_discussions WHERE id = $1`,
    [discussionId],
  );
  return rows[0] ?? null;
}

async function concludeDiscussion(
  discussionId: string,
  conclusion: string,
  conclusionKind: string | null,
): Promise<{ ok: true; row: CircleDiscussionRow } | { ok: false; status: number; error: string }> {
  if (!dbCtx) throw new Error("DB not initialized");
  const existing = await loadDiscussion(discussionId);
  if (!existing) return { ok: false, status: 404, error: "Discussion not found" };
  if (existing.status !== "open") {
    return { ok: false, status: 409, error: `Discussion already ${existing.status}` };
  }
  await dbCtx.execute(
    `UPDATE public.circle_discussions
        SET status = 'concluded', concluded_at = NOW(), conclusion = $2, conclusion_kind = $3
      WHERE id = $1`,
    [discussionId, conclusion, conclusionKind],
  );
  // Cancel any still-open per-turn issues so agents don't keep working on them.
  await dbCtx.execute(
    `UPDATE public.issues
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE origin_id = $1
        AND origin_kind IN ($2, $3)
        AND status IN ('backlog', 'todo', 'in_progress')`,
    [discussionId, DISCUSSION_TURN_ORIGIN_KIND, DISCUSSION_SUMMARY_ORIGIN_KIND],
  );
  const refreshed = await loadDiscussion(discussionId);
  return { ok: true, row: refreshed! };
}

/**
 * Try to parse the summariser's completion content as JSON
 * `{ summary, kind, suggestedFollowups? }`. Returns `{ summary, kind }` on
 * success or null when not parseable.
 */
function parseSummariserPayload(content: string): { summary: string; kind: string | null } | null {
  if (!content) return null;
  // Try to extract a fenced JSON block first; many LLMs wrap JSON in ```json ... ```
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(content);
  const candidates: string[] = [];
  if (fenceMatch && fenceMatch[1]) candidates.push(fenceMatch[1]);
  candidates.push(content.trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        const summary = typeof (parsed as Record<string, unknown>).summary === "string"
          ? ((parsed as Record<string, unknown>).summary as string)
          : null;
        const kind = typeof (parsed as Record<string, unknown>).kind === "string"
          ? ((parsed as Record<string, unknown>).kind as string)
          : null;
        if (summary) return { summary, kind };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Scheduler tick — invoked from the `advance-circle-discussions` plugin job
 * every minute. For each open discussion:
 *   1. Count this-round issues by status; if all `done`, increment
 *      `rounds_completed` (atomic, idempotent).
 *   2. If `rounds_completed < rounds_planned`, spawn next-round issues.
 *   3. Else if no summariser yet, spawn one (assigned to Secretary).
 *   4. If a summariser issue is `done`, parse its content and conclude.
 *
 * The function is intentionally tolerant of crashes mid-round: every spawn
 * checks `WHERE NOT EXISTS` first so re-running the tick never double-spawns.
 */
async function advanceCircleDiscussions(): Promise<{ checked: number; advanced: number; concluded: number }> {
  if (!dbCtx) return { checked: 0, advanced: 0, concluded: 0 };
  const open = await dbCtx.query<CircleDiscussionRow>(
    `SELECT * FROM public.circle_discussions WHERE status = 'open'`,
    [],
  );
  let advanced = 0;
  let concluded = 0;
  for (const discussion of open) {
    try {
      // Phase 1.15e — if we're in awaiting_commitments, check whether the
      // commit-to-support threshold has been reached (or 24h elapsed).
      if (discussion.phase === "awaiting_commitments") {
        const reached = await maybeConcludeViaCommitments(discussion);
        if (reached) concluded += 1;
        continue;
      }

      // Phase 1.15h-l F3 — SMART discussions walk through Robertson IDM's
      // 6 phases instead of the flat-rounds path. `advanceIdmPhase` advances
      // at most one phase per tick and is a no-op when the current phase is
      // already past the IDM range (which falls back to the legacy logic
      // below). For non-SMART discussions this branch is skipped entirely.
      if (
        isSmartDiscussion(discussion) &&
        (discussion.phase === "open" || IDM_DISCUSSION_PHASES.has(discussion.phase))
      ) {
        const moved = await advanceIdmPhase(discussion);
        if (moved) advanced += 1;
        continue;
      }

      // Always check if a summariser exists and is done first — that's the
      // terminal transition into awaiting_commitments.
      const summariser = await dbCtx.query<{ id: string; status: string }>(
        `SELECT id, status FROM public.issues
           WHERE origin_kind = $1 AND origin_id = $2 AND origin_fingerprint = 'summary'
           LIMIT 1`,
        [DISCUSSION_SUMMARY_ORIGIN_KIND, discussion.id],
      );
      if (summariser.length > 0 && summariser[0].status === "done") {
        const content = await readTurnContent(summariser[0].id);
        const parsed = content ? parseSummariserPayload(content) : null;
        const conclusionText = parsed?.summary ?? (content ?? "(summariser produced no content)");
        const conclusionKind = parsed?.kind ?? "note";
        // Transition into awaiting_commitments rather than directly concluded.
        await dbCtx.execute(
          `UPDATE public.circle_discussions
              SET phase = 'awaiting_commitments', conclusion = $2, conclusion_kind = $3
            WHERE id = $1 AND phase = 'open'`,
          [discussion.id, conclusionText, conclusionKind],
        );
        // Publish a commit-request event so participants can signal.
        try {
          await publishDiscussionEvent(discussion, {
            kind: "discussion-summariser-complete",
            conclusion: conclusionText.slice(0, 500),
            conclusionKind,
          });
        } catch {
          /* noop */
        }
        advanced += 1;
        continue;
      }

      // Otherwise, advance rounds.
      const currentRound = discussion.rounds_completed + 1;
      if (currentRound <= discussion.rounds_planned) {
        await advanceOneRound(discussion, currentRound);
      } else if (summariser.length === 0) {
        // All rounds already completed but no summariser yet — spawn it.
        const turns = await loadDiscussionTurns(discussion.id);
        await spawnSummariserIssue(discussion, turns);
      }
    } catch (err) {
      console.warn(
        "[holacracy] discussion scheduler error for",
        discussion.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { checked: open.length, advanced, concluded };
}

/**
 * Advance a single discussion through one round step. Handles both
 * `parallel` mode (all turns spawn at once; round completes when all done)
 * and the sequential modes — `psych_safety` (alias: legacy `reverse-priority`)
 * and `roundtable` — which spawn one turn at a time; the round completes when
 * `current_speaker_idx` reaches `participants.length`.
 */
async function advanceOneRound(
  discussion: CircleDiscussionRow,
  currentRound: number,
): Promise<void> {
  if (!dbCtx) return;
  const mode = discussion.speaker_mode ?? "psych_safety";

  if (mode === "parallel") {
    const counts = await dbCtx.query<{ status: string; total: number }>(
      `SELECT status, COUNT(*)::int AS total
         FROM public.issues
        WHERE origin_kind = $1 AND origin_id = $2 AND origin_fingerprint = $3
        GROUP BY status`,
      [DISCUSSION_TURN_ORIGIN_KIND, discussion.id, discussionFingerprint(currentRound)],
    );
    const total = counts.reduce((acc, c) => acc + c.total, 0);
    const doneCount = counts.find((c) => c.status === "done")?.total ?? 0;
    const expected = discussion.participant_agent_ids.length;
    if (total === expected && doneCount === expected) {
      await dbCtx.execute(
        `UPDATE public.circle_discussions
            SET rounds_completed = $2
          WHERE id = $1 AND rounds_completed = $3`,
        [discussion.id, currentRound, discussion.rounds_completed],
      );
      const refreshed = await loadDiscussion(discussion.id);
      if (!refreshed) return;
      const nextRound = refreshed.rounds_completed + 1;
      if (nextRound <= refreshed.rounds_planned) {
        const turns = await loadDiscussionTurns(refreshed.id);
        const digest = renderRoundDigest(turns, refreshed.rounds_completed);
        await spawnRoundTurnIssues({ discussion: refreshed, roundNumber: nextRound, digest });
      } else {
        const turns = await loadDiscussionTurns(refreshed.id);
        await spawnSummariserIssue(refreshed, turns);
      }
    }
    return;
  }

  // Sequential modes: reverse-priority / roundtable.
  const order = (discussion.speaker_order && discussion.speaker_order.length > 0)
    ? discussion.speaker_order
    : discussion.participant_agent_ids;
  const idx = discussion.current_speaker_idx ?? 0;
  if (order.length === 0) return;

  // If no current-speaker issue exists, spawn one.
  if (idx < order.length) {
    const currentAgentId = order[idx];
    const fingerprint = discussionFingerprint(currentRound);
    const existing = await dbCtx.query<{ id: string; status: string }>(
      `SELECT id, status FROM public.issues
         WHERE origin_kind = $1 AND origin_id = $2 AND origin_fingerprint = $3 AND assignee_agent_id = $4
         LIMIT 1`,
      [DISCUSSION_TURN_ORIGIN_KIND, discussion.id, fingerprint, currentAgentId],
    );
    if (existing.length === 0) {
      // Spawn just this agent's turn.
      const turns = await loadDiscussionTurns(discussion.id);
      const digest = discussion.rounds_completed > 0
        ? renderRoundDigest(turns, discussion.rounds_completed)
        : null;
      await spawnRoundTurnIssues({
        discussion,
        roundNumber: currentRound,
        digest,
        onlyAgents: [currentAgentId],
      });
      return;
    }
    if (existing[0].status === "done") {
      // Advance to next speaker.
      const nextIdx = idx + 1;
      await dbCtx.execute(
        `UPDATE public.circle_discussions
            SET current_speaker_idx = $2
          WHERE id = $1 AND current_speaker_idx = $3`,
        [discussion.id, nextIdx, idx],
      );
      const refreshed = await loadDiscussion(discussion.id);
      if (!refreshed) return;
      if (nextIdx < order.length) {
        // Spawn next speaker's issue on the next tick.
        return;
      }
      // Round complete — promote.
      await dbCtx.execute(
        `UPDATE public.circle_discussions
            SET rounds_completed = $2, current_speaker_idx = 0
          WHERE id = $1 AND rounds_completed = $3`,
        [refreshed.id, currentRound, refreshed.rounds_completed],
      );
      const promoted = await loadDiscussion(refreshed.id);
      if (!promoted) return;
      const nextRound = promoted.rounds_completed + 1;
      if (nextRound <= promoted.rounds_planned) {
        // Round-N+1's first speaker will be spawned next tick.
        return;
      }
      const turns = await loadDiscussionTurns(promoted.id);
      await spawnSummariserIssue(promoted, turns);
    }
    // status not done — wait.
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.15h-l F3 — Robertson IDM 6-phase advancer.
//
// SMART discussions (those with a non-empty `success_criterion`) walk through
// Robertson's Integrative Decision-Making phases instead of the legacy
// flat-rounds flow. The advancer is idempotent: spawn calls are guarded by
// `WHERE NOT EXISTS` inside `spawnRoundTurnIssues`, and phase UPDATEs use
// `WHERE phase = <old>` so a second tick in the same scheduler interval
// never double-advances.
//
// Phase machine:
//   open                 → proposal              (when first turn issue exists)
//   proposal             → clarifying_questions  (proposer's turn done)
//   clarifying_questions → reactions             (all non-proposer turns done)
//   reactions            → amend                 (all participant reaction turns done)
//   amend                → objections            (proposer's amend turn done)
//   objections           → integration | awaiting_commitments
//                                                (>=1 objection vs zero)
//   integration          → objections | awaiting_commitments
//                                                (next cycle or cap reached)
//   awaiting_commitments → concluded             (existing path; unchanged)
//
// Integration ⇄ objections is bounded by MAX_INTEGRATION_CYCLES to prevent
// infinite ping-pong; the counter lives on `circle_discussions.integration_cycles_count`.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_INTEGRATION_CYCLES = 3;

/** Phases that the IDM advancer manages. The advancer is a no-op for any
 *  other `discussion.phase` value (e.g. `awaiting_commitments`, `concluded`,
 *  `deadlocked`, or legacy `open` on non-SMART discussions). */
const IDM_DISCUSSION_PHASES = new Set([
  "proposal",
  "clarifying_questions",
  "reactions",
  "amend",
  "objections",
  "integration",
]);

/** A discussion is "SMART" / IDM-track when it has at least a success
 *  criterion. The plugin-holacracy SMART creation path always populates this;
 *  legacy discussions don't, and they keep the flat-rounds path. */
function isSmartDiscussion(d: CircleDiscussionRow): boolean {
  return typeof d.success_criterion === "string" && d.success_criterion.trim().length > 0;
}

/** Resolve the proposer: prefer the explicit initiator; fall back to the
 *  first slot in speaker_order; final fallback to the first participant. */
function resolveProposerAgentId(d: CircleDiscussionRow): string | null {
  if (d.initiated_by_agent_id) return d.initiated_by_agent_id;
  if (d.speaker_order && d.speaker_order.length > 0) return d.speaker_order[0];
  if (d.participant_agent_ids.length > 0) return d.participant_agent_ids[0];
  return null;
}

function resolveNonProposerAgentIds(d: CircleDiscussionRow): string[] {
  const proposer = resolveProposerAgentId(d);
  return d.participant_agent_ids.filter((id) => id !== proposer);
}

/** Build an `origin_fingerprint` for an IDM phase turn issue. The optional
 *  `cycle` index disambiguates repeat `objections`/`integration` rounds so
 *  each cycle's issues are tracked independently. */
function idmPhaseFingerprint(phase: string, cycle = 0): string {
  return cycle === 0 ? `idm-${phase}` : `idm-${phase}-c${cycle}`;
}

/** Per-phase extra prompt surfaced on the issue description. Kept terse here;
 *  F2 will replace these with Robertson-faithful phase-specific guidance. */
function idmPhasePrompt(phase: string): string {
  switch (phase) {
    case "proposal":
      return "## IDM Phase 1 — Proposal\n\nDraft your concrete proposal addressing the success criterion. Be specific.";
    case "clarifying_questions":
      return "## IDM Phase 2 — Clarifying Questions\n\nAsk ONE clarifying question about the proposal, or reply `PASS` if the proposal is already clear. No reactions or objections in this phase.";
    case "reactions":
      return "## IDM Phase 3 — Reactions\n\nShare your reaction to the proposal. Do not address other reactions — speak directly to the proposer.";
    case "amend":
      return "## IDM Phase 4 — Amend or Clarify\n\nBased on reactions, you MAY amend the proposal or clarify intent. Reply `NO CHANGE` to keep the proposal as-is.";
    case "objections":
      return "## IDM Phase 5 — Objections\n\nDo you see a reason adopting this proposal would cause harm or move the circle backwards? Reply `NO OBJECTION`, otherwise state the objection.";
    case "integration":
      return "## IDM Phase 6 — Integration\n\nIntegrate the raised objection(s) into the proposal so neither the objection nor the proposal's original tension stand. Reply `NO CHANGE` to leave the proposal unchanged.";
    default:
      return "";
  }
}

/** Aggregate completion stats for a given phase fingerprint. Treats both
 *  `done` and `cancelled` as "no longer blocking advancement". */
async function countPhaseTurns(
  discussionId: string,
  fingerprint: string,
): Promise<{ total: number; finished: number; doneIds: string[] }> {
  if (!dbCtx) return { total: 0, finished: 0, doneIds: [] };
  const rows = await dbCtx.query<{ id: string; status: string }>(
    `SELECT id, status FROM public.issues
       WHERE origin_kind = $1 AND origin_id = $2 AND origin_fingerprint = $3`,
    [DISCUSSION_TURN_ORIGIN_KIND, discussionId, fingerprint],
  );
  let finished = 0;
  const doneIds: string[] = [];
  for (const r of rows) {
    if (r.status === "done" || r.status === "cancelled") {
      finished += 1;
      if (r.status === "done") doneIds.push(r.id);
    }
  }
  return { total: rows.length, finished, doneIds };
}

/** Heuristic: does an objection-phase turn body indicate an actual objection?
 *  We treat "NO OBJECTION" (or "no-objection" / "no_objection") as the
 *  unanimous-pass signal. Anything else is treated as raising an objection.
 *  Empty/null content is conservatively treated as "no objection raised". */
function turnRaisesObjection(content: string | null): boolean {
  if (!content) return false;
  const normalised = content.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (normalised.length === 0) return false;
  // Quick allow-list of "no objection" phrasings; anything else is an objection.
  if (normalised.startsWith("no objection")) return false;
  if (normalised.includes("no objection")) return false;
  return true;
}

/** Persist a phase transition; idempotent via the WHERE clause. Returns the
 *  refreshed row if the UPDATE actually changed anything, else null. */
async function setDiscussionPhase(
  discussionId: string,
  fromPhase: string,
  toPhase: string,
): Promise<CircleDiscussionRow | null> {
  if (!dbCtx) return null;
  await dbCtx.execute(
    `UPDATE public.circle_discussions
        SET phase = $3
      WHERE id = $1 AND phase = $2`,
    [discussionId, fromPhase, toPhase],
  );
  const refreshed = await loadDiscussion(discussionId);
  if (!refreshed || refreshed.phase !== toPhase) return null;
  try {
    await publishDiscussionEvent(refreshed, {
      kind: "discussion-idm-phase-advance",
      fromPhase,
      toPhase,
    });
  } catch {
    /* best-effort */
  }
  return refreshed;
}

/**
 * Phase 1.15h-l F3 — Walk a SMART discussion through Robertson's 6 IDM phases.
 * Called from `advanceCircleDiscussions` for any discussion where
 * `isSmartDiscussion(d)` is true and the current phase is one of the IDM
 * phases (or `open` for the initial promotion).
 *
 * Each invocation advances at most one phase; subsequent ticks pick up the
 * next phase. The function is idempotent — re-running it on the same tick
 * is a no-op once the phase has already transitioned (UPDATE …
 * WHERE phase = <old> filters that out).
 */
async function advanceIdmPhase(discussion: CircleDiscussionRow): Promise<boolean> {
  if (!dbCtx) return false;
  const proposerId = resolveProposerAgentId(discussion);
  if (!proposerId) return false; // can't run IDM without a proposer
  const nonProposers = resolveNonProposerAgentIds(discussion);

  // open → proposal. We trust the createDiscussion path to have spawned the
  // first round-1 turn issue (which doubles as the proposal turn for
  // backwards-compat). If no round-1 issue exists yet, wait — the next tick
  // will catch it. The proposal turn issue itself is also spawned under the
  // `idm-proposal` fingerprint so the phase advancer can track it directly.
  if (discussion.phase === "open") {
    // Spawn the canonical proposal turn (assigned to the proposer).
    await spawnRoundTurnIssues({
      discussion,
      roundNumber: 1,
      digest: null,
      onlyAgents: [proposerId],
      fingerprintOverride: idmPhaseFingerprint("proposal"),
      extraPrompt: idmPhasePrompt("proposal"),
    });
    const refreshed = await setDiscussionPhase(discussion.id, "open", "proposal");
    return refreshed !== null;
  }

  if (discussion.phase === "proposal") {
    const stats = await countPhaseTurns(discussion.id, idmPhaseFingerprint("proposal"));
    if (stats.total === 0) {
      // Defensive: re-spawn if the issue was deleted somehow.
      await spawnRoundTurnIssues({
        discussion,
        roundNumber: 1,
        digest: null,
        onlyAgents: [proposerId],
        fingerprintOverride: idmPhaseFingerprint("proposal"),
        extraPrompt: idmPhasePrompt("proposal"),
      });
      return false;
    }
    if (stats.finished < stats.total) return false;
    // Proposer's turn done — spawn clarifying turns for non-proposers.
    if (nonProposers.length > 0) {
      await spawnRoundTurnIssues({
        discussion,
        roundNumber: 2,
        digest: null,
        onlyAgents: nonProposers,
        fingerprintOverride: idmPhaseFingerprint("clarifying_questions"),
        extraPrompt: idmPhasePrompt("clarifying_questions"),
      });
    }
    const refreshed = await setDiscussionPhase(discussion.id, "proposal", "clarifying_questions");
    return refreshed !== null;
  }

  if (discussion.phase === "clarifying_questions") {
    // Zero non-proposers (1-agent discussion) → skip straight to reactions.
    if (nonProposers.length === 0) {
      await spawnRoundTurnIssues({
        discussion,
        roundNumber: 3,
        digest: null,
        onlyAgents: discussion.participant_agent_ids,
        fingerprintOverride: idmPhaseFingerprint("reactions"),
        extraPrompt: idmPhasePrompt("reactions"),
      });
      const r = await setDiscussionPhase(discussion.id, "clarifying_questions", "reactions");
      return r !== null;
    }
    const stats = await countPhaseTurns(
      discussion.id,
      idmPhaseFingerprint("clarifying_questions"),
    );
    if (stats.total < nonProposers.length || stats.finished < stats.total) return false;
    // All clarifying turns done — spawn reactions for all participants.
    await spawnRoundTurnIssues({
      discussion,
      roundNumber: 3,
      digest: null,
      onlyAgents: discussion.participant_agent_ids,
      fingerprintOverride: idmPhaseFingerprint("reactions"),
      extraPrompt: idmPhasePrompt("reactions"),
    });
    const refreshed = await setDiscussionPhase(
      discussion.id,
      "clarifying_questions",
      "reactions",
    );
    return refreshed !== null;
  }

  if (discussion.phase === "reactions") {
    const stats = await countPhaseTurns(discussion.id, idmPhaseFingerprint("reactions"));
    if (
      stats.total < discussion.participant_agent_ids.length ||
      stats.finished < stats.total
    ) {
      return false;
    }
    // Reactions done — spawn the proposer's amend turn.
    await spawnRoundTurnIssues({
      discussion,
      roundNumber: 4,
      digest: null,
      onlyAgents: [proposerId],
      fingerprintOverride: idmPhaseFingerprint("amend"),
      extraPrompt: idmPhasePrompt("amend"),
    });
    const refreshed = await setDiscussionPhase(discussion.id, "reactions", "amend");
    return refreshed !== null;
  }

  if (discussion.phase === "amend") {
    const stats = await countPhaseTurns(discussion.id, idmPhaseFingerprint("amend"));
    if (stats.total === 0 || stats.finished < stats.total) return false;
    // Amend done — spawn objections turns for non-proposers (cycle 0).
    const cycle = discussion.integration_cycles_count; // first time: 0
    if (nonProposers.length > 0) {
      await spawnRoundTurnIssues({
        discussion,
        roundNumber: 5,
        digest: null,
        onlyAgents: nonProposers,
        fingerprintOverride: idmPhaseFingerprint("objections", cycle),
        extraPrompt: idmPhasePrompt("objections"),
      });
    }
    const refreshed = await setDiscussionPhase(discussion.id, "amend", "objections");
    return refreshed !== null;
  }

  if (discussion.phase === "objections") {
    const cycle = discussion.integration_cycles_count;
    const fingerprint = idmPhaseFingerprint("objections", cycle);
    // 1-agent edge case: no non-proposers means no objection turns to wait on.
    if (nonProposers.length === 0) {
      await setDiscussionPhase(discussion.id, "objections", "awaiting_commitments");
      return true;
    }
    const stats = await countPhaseTurns(discussion.id, fingerprint);
    if (stats.total < nonProposers.length || stats.finished < stats.total) return false;
    // Test for objections: scan each done turn's content + any commit signals.
    let objectionCount = 0;
    for (const issueId of stats.doneIds) {
      const content = await readTurnContent(issueId);
      if (turnRaisesObjection(content)) objectionCount += 1;
    }
    if (objectionCount === 0) {
      // Also check commit-signal objections (defensive — commits typically
      // only arrive in awaiting_commitments, but the spec allows either path).
      const commits = await dbCtx.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM public.discussion_commitments
          WHERE discussion_id = $1 AND signal IN ('support-with-objection', 'block')`,
        [discussion.id],
      );
      if ((commits[0]?.count ?? 0) > 0) objectionCount = commits[0].count;
    }
    if (objectionCount === 0) {
      const refreshed = await setDiscussionPhase(
        discussion.id,
        "objections",
        "awaiting_commitments",
      );
      return refreshed !== null;
    }
    // ≥1 objection — spawn the proposer's integration turn for this cycle.
    await spawnRoundTurnIssues({
      discussion,
      roundNumber: 6,
      digest: null,
      onlyAgents: [proposerId],
      fingerprintOverride: idmPhaseFingerprint("integration", cycle),
      extraPrompt: idmPhasePrompt("integration"),
    });
    const refreshed = await setDiscussionPhase(discussion.id, "objections", "integration");
    return refreshed !== null;
  }

  if (discussion.phase === "integration") {
    const cycle = discussion.integration_cycles_count;
    const fingerprint = idmPhaseFingerprint("integration", cycle);
    const stats = await countPhaseTurns(discussion.id, fingerprint);
    if (stats.total === 0 || stats.finished < stats.total) return false;
    // Integration turn done — increment cycle counter, then either re-test
    // objections (spawn next cycle's objection turns) or force-promote if
    // we've hit MAX_INTEGRATION_CYCLES.
    const nextCycle = cycle + 1;
    await dbCtx.execute(
      `UPDATE public.circle_discussions
          SET integration_cycles_count = $2
        WHERE id = $1 AND integration_cycles_count = $3`,
      [discussion.id, nextCycle, cycle],
    );
    if (nextCycle >= MAX_INTEGRATION_CYCLES) {
      const refreshed = await setDiscussionPhase(
        discussion.id,
        "integration",
        "awaiting_commitments",
      );
      return refreshed !== null;
    }
    // Re-spawn objection turns for the new cycle.
    if (nonProposers.length > 0) {
      await spawnRoundTurnIssues({
        discussion,
        roundNumber: 5,
        digest: null,
        onlyAgents: nonProposers,
        fingerprintOverride: idmPhaseFingerprint("objections", nextCycle),
        extraPrompt: idmPhasePrompt("objections"),
      });
    }
    const refreshed = await setDiscussionPhase(discussion.id, "integration", "objections");
    return refreshed !== null;
  }

  return false;
}

/**
 * Phase 1.15h-i #9 — Bridge a concluding discussion into an `idm_approvals`
 * row so the canonical 6-phase IDM state machine runs on any objections.
 *
 * Fires only when the discussion has at least one `support-with-objection`
 * or `block` commitment. Skips when no objectors (the discussion-layer
 * commitment threshold path is sufficient) or when the discussion has no
 * circle_id (idm_approvals.circle_id is NOT NULL — cross-circle 1:1
 * discussions cannot bridge). Idempotent on `discussion.idm_approval_id`.
 *
 * The resulting IDM row is seeded directly in phase `objections`, skipping
 * `clarifying` + `reactions` since those already happened in the discussion.
 * Each objector commitment becomes one `idm_objections` row (body =
 * commitment.reason). From here the existing deadline sweeper drives
 * `idmAdvance`, and Facilitator agents resolve via the existing
 * `holacracy-idm-validate-objection` + `holacracy-idm-integrate` tools.
 */
/**
 * F4 — Robertson's 3 objection-validity tests applied as a deterministic
 * heuristic at seed time, so the Facilitator has a starting point and `is_valid`
 * isn't left null forever.
 *
 * Robertson (Holacracy ch.4 + GTD §4.4): an objection is valid only if ALL three:
 *   1. The proposal would CAUSE NEW HARM (not current-state harm — that's a
 *      separate tension)
 *   2. The harm FOLLOWS FROM THE PROPOSAL TEXT (not speculation about how it
 *      will be applied)
 *   3. The harm is based on CURRENT KNOWLEDGE or near-term forecast (not
 *      hypothetical "what if in 5 years")
 *
 * The Facilitator agent may override any of these via
 * `holacracy-idm-validate-objection` — this heuristic just gives the IDM
 * machinery a starting verdict instead of stalling at null.
 */
function computeObjectionValidityHeuristic(
  objectionBody: string,
  proposalContent: unknown,
): {
  test_unworkable: { result: boolean | null; rationale: string };
  test_follows_from_proposal: { result: boolean | null; rationale: string };
  test_current_not_speculation: { result: boolean | null; rationale: string };
} {
  const body = (objectionBody ?? "").toLowerCase();
  if (body.trim().length === 0) {
    const empty = { result: null, rationale: "objection body is empty" } as const;
    return { test_unworkable: empty, test_follows_from_proposal: empty, test_current_not_speculation: empty };
  }

  // (1) NEW HARM — look for harm/breakage language
  const harmTerms = ["harm", "broke", "break", "fail", "blocks", "block ", "damages", "damage", "loses", "lose", "loss", "regression", "regress", "won't work", "wont work", "doesn't work", "doesnt work", "cannot work"];
  const mentionsHarm = harmTerms.some((t) => body.includes(t));
  const test_unworkable = mentionsHarm
    ? { result: true, rationale: "objection body identifies concrete harm/breakage" }
    : { result: false, rationale: "no harm-language in objection body (no break/fail/block/damage); may be a tension, not an objection" };

  // (2) FOLLOWS FROM PROPOSAL TEXT — naive lexical overlap with proposal
  const proposalText = typeof proposalContent === "string"
    ? proposalContent
    : (() => { try { return JSON.stringify(proposalContent); } catch { return ""; } })();
  const proposalWords = new Set(
    proposalText.toLowerCase().match(/\b[a-z]{4,}\b/g)?.filter((w) => !STOPWORDS.has(w)) ?? [],
  );
  const objectionWords = body.match(/\b[a-z]{4,}\b/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
  let overlap = 0;
  for (const w of objectionWords) if (proposalWords.has(w)) overlap++;
  const followsFromProposal = overlap >= 2;
  const test_follows_from_proposal = followsFromProposal
    ? { result: true, rationale: `objection references proposal text (${overlap} content-word overlap)` }
    : { result: false, rationale: `objection has <2 content-word overlap with proposal; may be tangential rather than following from proposal text` };

  // (3) CURRENT NOT SPECULATION — look for speculation markers
  const speculationMarkers = [
    "what if", "could happen", "might happen", "may happen", "in the future", "years from now",
    "5 years", "10 years", "hypothetically", "speculative", "imagine if", "someday",
  ];
  const isSpeculation = speculationMarkers.some((m) => body.includes(m));
  const test_current_not_speculation = isSpeculation
    ? { result: false, rationale: `objection contains speculation marker; Robertson invalidates hypothetical concerns` }
    : { result: true, rationale: "no speculation markers detected; grounded in current/near-term" };

  return { test_unworkable, test_follows_from_proposal, test_current_not_speculation };
}

const STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "have", "will", "would", "could", "should",
  "what", "when", "where", "which", "their", "there", "about", "they", "them", "your", "yours",
  "into", "than", "then", "such", "some", "more", "most", "other", "only", "also", "been",
  "being", "were", "because", "while", "shall", "must", "does", "doing", "having",
]);

async function bridgeDiscussionToIdm(
  discussion: CircleDiscussionRow,
): Promise<{ idmApprovalId: string; objectionCount: number } | null> {
  if (!dbCtx) return null;
  if (discussion.idm_approval_id) return null; // idempotent
  if (!discussion.circle_id) return null; // idm_approvals.circle_id is NOT NULL

  const objectors = await dbCtx.query<{ agent_id: string; signal: string; reason: string | null }>(
    `SELECT agent_id::text AS agent_id, signal, reason
       FROM public.discussion_commitments
      WHERE discussion_id = $1
        AND signal IN ('support-with-objection', 'block')
      ORDER BY signaled_at ASC`,
    [discussion.id],
  );
  if (objectors.length === 0) return null;

  // Parse the Secretary's structured payload when possible — surface
  // `current_proposal` or fall back to `summary`/raw text as the IDM
  // proposal content. The IDM proposal schema accepts arbitrary `content`
  // (z.unknown), so any of these shapes is valid downstream.
  let proposalContent: unknown = discussion.conclusion ?? "(no conclusion text)";
  if (discussion.conclusion) {
    try {
      const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(discussion.conclusion);
      const candidate = fenceMatch && fenceMatch[1] ? fenceMatch[1] : discussion.conclusion.trim();
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.current_proposal === "string" && rec.current_proposal.trim().length > 0) {
          proposalContent = rec.current_proposal;
        } else if (typeof rec.summary === "string" && rec.summary.trim().length > 0) {
          proposalContent = rec.summary;
        } else {
          proposalContent = parsed;
        }
      }
    } catch {
      /* keep raw text */
    }
  }

  const kind = discussion.expected_output_kind ?? discussion.conclusion_kind ?? "note";

  let proposed: { idm: IdmApprovalRow; approvalId: string };
  try {
    proposed = await idmPropose({
      companyId: discussion.company_id,
      circleId: discussion.circle_id,
      ...(discussion.motivating_tension_id ? { tensionId: discussion.motivating_tension_id } : {}),
      ...(discussion.initiated_by_agent_id ? { proposerAgentId: discussion.initiated_by_agent_id } : {}),
      proposal: { kind, content: proposalContent },
    });
  } catch (err) {
    console.warn(
      "[holacracy] bridgeDiscussionToIdm: idmPropose failed for discussion",
      discussion.id,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Skip clarifying + reactions + amend_or_clarify — those happened in the
  // discussion. Drop straight into `objections` with a fresh deadline.
  await setIdmPhase(proposed.idm.id, IDM_PHASES.objections);

  // Seed one idm_objections row per objector commitment. Resolve their
  // role_id in this circle (best-effort — NULL is allowed on raised_by_role_id).
  let objectionCount = 0;
  for (const o of objectors) {
    let roleId: string | null = null;
    try {
      const roleRows = await dbCtx.query<{ id: string }>(
        `SELECT r.id::text AS id
           FROM ${tbl("role_assignments")} ra
           JOIN ${tbl("roles")} r ON r.id = ra.role_id
          WHERE ra.agent_id = $1 AND r.circle_id = $2
          ORDER BY ra.created_at ASC NULLS LAST
          LIMIT 1`,
        [o.agent_id, discussion.circle_id],
      );
      roleId = roleRows[0]?.id ?? null;
    } catch {
      /* role_assignments.created_at may not exist on every install */
    }
    const body = (o.reason ?? "").trim().length > 0
      ? (o.reason as string)
      : `[bridged from discussion ${discussion.id.slice(0, 8)}] signal=${o.signal} (no reason given)`;
    // F4 — Robertson's 3 objection-validity tests, applied as a fast heuristic
    // at seed time. The Facilitator agent can override these via
    // holacracy-idm-validate-objection; without that, this gives V3 a real
    // pass-fail signal instead of leaving the fields null forever.
    const tests = computeObjectionValidityHeuristic(body, proposalContent);
    const allPass = tests.test_unworkable.result === true
      && tests.test_follows_from_proposal.result === true
      && tests.test_current_not_speculation.result === true;
    const anyFail = tests.test_unworkable.result === false
      || tests.test_follows_from_proposal.result === false
      || tests.test_current_not_speculation.result === false;
    const isValid: boolean | null = allPass ? true : anyFail ? false : null;
    try {
      await dbCtx.execute(
        `INSERT INTO ${tbl("idm_objections")} (
            id, idm_id, raised_by_agent_id, raised_by_role_id, body,
            test_unworkable, test_follows_from_proposal, test_current_not_speculation,
            is_valid, validated_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
        [
          randomUUID(),
          proposed.idm.id,
          o.agent_id,
          roleId,
          body,
          JSON.stringify(tests.test_unworkable),
          JSON.stringify(tests.test_follows_from_proposal),
          JSON.stringify(tests.test_current_not_speculation),
          isValid,
          isValid !== null ? new Date().toISOString() : null,
        ],
      );
      objectionCount += 1;
    } catch (err) {
      console.warn(
        "[holacracy] bridgeDiscussionToIdm: failed to seed objection",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Link the IDM approval back onto the discussion row.
  try {
    await dbCtx.execute(
      `UPDATE public.circle_discussions SET idm_approval_id = $2 WHERE id = $1`,
      [discussion.id, proposed.idm.id],
    );
  } catch (err) {
    console.warn(
      "[holacracy] bridgeDiscussionToIdm: failed to back-link idm_approval_id",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { idmApprovalId: proposed.idm.id, objectionCount };
}

/**
 * Phase 1.15e — Check the commitment threshold for a discussion in
 * `awaiting_commitments` phase. If ≥ threshold * participants have signaled
 * `support` or `support-with-objection` AND there are no unresolved blocks,
 * transition `phase='concluded'`. If 24h have elapsed since the discussion
 * entered awaiting_commitments and the threshold isn't met, also conclude
 * with `conclusion_kind='deadlocked'`. Returns true if the transition fired.
 */
async function maybeConcludeViaCommitments(
  discussion: CircleDiscussionRow,
): Promise<boolean> {
  if (!dbCtx) return false;
  const rows = await dbCtx.query<{ signal: string; count: number }>(
    `SELECT signal, COUNT(*)::int AS count
       FROM public.discussion_commitments
      WHERE discussion_id = $1
      GROUP BY signal`,
    [discussion.id],
  );
  let support = 0;
  let supportWithObjection = 0;
  let block = 0;
  for (const r of rows) {
    if (r.signal === "support") support += r.count;
    else if (r.signal === "support-with-objection") supportWithObjection += r.count;
    else if (r.signal === "block") block += r.count;
  }
  const totalParticipants = discussion.participant_agent_ids.length;
  const threshold = discussion.required_commitment_threshold ?? 0.8;
  const supporting = support + supportWithObjection;
  const supportingFraction = totalParticipants > 0 ? supporting / totalParticipants : 0;

  if (block === 0 && supportingFraction >= threshold) {
    // Phase 1.15h-i #9 — If any objectors signaled support-with-objection,
    // open an IDM approval BEFORE flipping to concluded so the canonical
    // 6-phase state machine runs on those objections.
    let bridge: { idmApprovalId: string; objectionCount: number } | null = null;
    if (supportWithObjection > 0) {
      try {
        bridge = await bridgeDiscussionToIdm(discussion);
      } catch (err) {
        console.warn(
          "[holacracy] bridgeDiscussionToIdm threw during conclude path:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await dbCtx.execute(
      `UPDATE public.circle_discussions
          SET phase = 'concluded', status = 'concluded', concluded_at = NOW()
        WHERE id = $1 AND phase = 'awaiting_commitments'`,
      [discussion.id],
    );
    try {
      await publishDiscussionEvent(discussion, {
        kind: "discussion-concluded",
        threshold,
        supporting,
        supportingFraction,
      });
      if (bridge) {
        await publishDiscussionEvent(discussion, {
          kind: "discussion-bridged-to-idm",
          idmApprovalId: bridge.idmApprovalId,
          objectionCount: bridge.objectionCount,
          phase: IDM_PHASES.objections,
        });
        console.log(
          `[holacracy] bridged discussion ${discussion.id.slice(0, 8)} → IDM ${bridge.idmApprovalId.slice(0, 8)} (${bridge.objectionCount} objection(s))`,
        );
      }
    } catch {
      /* noop */
    }
    return true;
  }

  // 24h timeout deadlock check.
  const startedAt = discussion.started_at ? new Date(discussion.started_at).getTime() : Date.now();
  const ageHours = (Date.now() - startedAt) / (1000 * 60 * 60);
  if (ageHours > 24 && supportingFraction < threshold) {
    // Phase 1.15h-i #9 — Even on deadlock, if there are objector signals
    // they deserve to run through IDM rather than being silently dropped.
    let bridge: { idmApprovalId: string; objectionCount: number } | null = null;
    if (supportWithObjection > 0 || block > 0) {
      try {
        bridge = await bridgeDiscussionToIdm(discussion);
      } catch (err) {
        console.warn(
          "[holacracy] bridgeDiscussionToIdm threw during deadlock path:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await dbCtx.execute(
      `UPDATE public.circle_discussions
          SET phase = 'concluded', status = 'concluded', concluded_at = NOW(),
              conclusion_kind = COALESCE(conclusion_kind, 'deadlocked')
        WHERE id = $1 AND phase = 'awaiting_commitments'`,
      [discussion.id],
    );
    try {
      await publishDiscussionEvent(discussion, {
        kind: "discussion-deadlocked",
        threshold,
        supporting,
        supportingFraction,
      });
      if (bridge) {
        await publishDiscussionEvent(discussion, {
          kind: "discussion-bridged-to-idm",
          idmApprovalId: bridge.idmApprovalId,
          objectionCount: bridge.objectionCount,
          phase: IDM_PHASES.objections,
        });
        console.log(
          `[holacracy] bridged deadlocked discussion ${discussion.id.slice(0, 8)} → IDM ${bridge.idmApprovalId.slice(0, 8)} (${bridge.objectionCount} objection(s))`,
        );
      }
    } catch {
      /* noop */
    }
    return true;
  }
  return false;
}

// ── Phase 1.15d/e/g — repair, commit, 1:1 tool helpers ─────────────────────

/**
 * Phase 1.15c — Check if caller agent is currently allowed to speak in any
 * active sequential-mode discussion (reverse-priority / roundtable). When
 * the caller is in an active sequential round but is NOT the current speaker,
 * we refuse cross-talk for `holacracy-talk-to-agent` and `holacracy-broadcast-
 * to-circle`. Clarifying questions (separate channel) are exempt.
 *
 * Returns `null` when allowed; returns an error message when blocked.
 */
async function checkCrossTalkBlock(
  agentId: string,
  options?: { allowedKinds?: Set<string> },
): Promise<string | null> {
  if (!dbCtx) return null;
  const _ = options; // keep symbol used to silence TS
  try {
    const rows = await dbCtx.query<{
      id: string;
      speaker_mode: string;
      current_speaker_idx: number;
      speaker_order: string[];
      participant_agent_ids: string[];
    }>(
      `SELECT id, speaker_mode, current_speaker_idx, speaker_order, participant_agent_ids
         FROM public.circle_discussions
        WHERE status = 'open' AND phase = 'open'
          AND speaker_mode IN ('psych_safety', 'reverse-priority', 'roundtable')
          AND $1::uuid = ANY(participant_agent_ids)`,
      [agentId],
    );
    for (const d of rows) {
      const order = (d.speaker_order && d.speaker_order.length > 0)
        ? d.speaker_order
        : d.participant_agent_ids;
      const current = order[d.current_speaker_idx ?? 0] ?? null;
      if (current && current !== agentId) {
        return `Wait your turn. Discussion ${d.id} is in ${d.speaker_mode} mode; current speaker is ${current.slice(0, 8)}.`;
      }
    }
  } catch {
    /* best-effort */
  }
  return null;
}

interface AskClarifyingParams {
  targetAgentId: string;
  contextId: string;
  question: string;
}

async function runAskClarifyingQuestion(
  params: AskClarifyingParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!mqttCtx) return { content: "MQTT not available", error: "mqtt_unavailable" };
  const target = await resolveAgentHomeCircle(runCtx.companyId, params.targetAgentId);
  if (!target) {
    return { content: `Target agent ${params.targetAgentId} has no role assignment in your company`, error: "no_target_circle" };
  }
  const { requestTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
  const taskId = randomUUID();
  const taskPayload = {
    id: taskId,
    kind: "task",
    contextId: params.contextId,
    message: { role: "user", parts: [{ text: params.question }] },
  };
  const reqTopic = requestTopic(target.companyId, target.circleId, params.targetAgentId);
  try {
    await mqttCtx.publishAs(runCtx.agentId, reqTopic, taskPayload, {
      qos: 1,
      retain: false,
      userProperties: {
        "a2a-task-kind": "clarifying-question",
        "a2a-source": "holacracy-tool",
        "paperclip-discussion-context-id": params.contextId,
      },
    });
  } catch (err) {
    return { content: `publishAs failed: ${err instanceof Error ? err.message : String(err)}`, error: "publish_failed" };
  }
  return {
    content: JSON.stringify({ taskId, contextId: params.contextId, kind: "clarifying-question", note: "Not counted as a discussion turn" }, null, 2),
  };
}

interface RetractTurnParams {
  turnIssueId: string;
  reason: string;
}

async function runRetractTurn(
  params: RetractTurnParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!dbCtx) return { content: "DB not available", error: "db_unavailable" };
  const rows = await dbCtx.query<{
    id: string;
    assignee_agent_id: string | null;
    origin_kind: string;
    origin_id: string;
    origin_fingerprint: string;
    status: string;
  }>(
    `SELECT id, assignee_agent_id, origin_kind, origin_id, origin_fingerprint, status
       FROM public.issues WHERE id = $1`,
    [params.turnIssueId],
  );
  if (rows.length === 0) return { content: "Turn issue not found", error: "not_found" };
  const turn = rows[0];
  if (turn.assignee_agent_id !== runCtx.agentId) {
    return { content: "Cannot retract another agent's turn", error: "not_yours" };
  }
  if (turn.origin_kind !== "discussion:turn") {
    return { content: "Issue is not a discussion turn", error: "wrong_origin" };
  }
  await dbCtx.execute(
    `UPDATE public.issues SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [params.turnIssueId],
  );
  // Insert a retraction comment.
  await dbCtx.execute(
    `INSERT INTO public.issue_comments (id, issue_id, agent_id, body) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), params.turnIssueId, runCtx.agentId, `[RETRACTED] ${params.reason}`],
  );
  const discussion = await loadDiscussion(turn.origin_id);
  if (discussion) {
    try {
      await publishDiscussionEvent(discussion, {
        kind: "discussion-turn-retracted",
        turnIssueId: params.turnIssueId,
        agentId: runCtx.agentId,
        reason: params.reason,
      });
    } catch {
      /* noop */
    }
  }
  return { content: JSON.stringify({ turnIssueId: params.turnIssueId, retracted: true }, null, 2) };
}

interface CommitToConclusionParams {
  discussionId: string;
  signal: "support" | "support-with-objection" | "block";
  reason?: string;
}

async function runCommitToConclusion(
  params: CommitToConclusionParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  if (!dbCtx) return { content: "DB not available", error: "db_unavailable" };
  const discussion = await loadDiscussion(params.discussionId);
  if (!discussion) return { content: "Discussion not found", error: "not_found" };
  if (!discussion.participant_agent_ids.includes(runCtx.agentId)) {
    return { content: "You are not a participant in this discussion", error: "not_a_participant" };
  }
  // Validate block standing. Only Lead Link / Secretary / Facilitator / domain
  // owner can block. We check via role_type in the discussion's circle.
  let effectiveSignal = params.signal;
  if (params.signal === "block" && discussion.circle_id) {
    try {
      const rows = await dbCtx.query<{ role_type: string }>(
        `SELECT r.role_type
           FROM ${tbl("role_assignments")} ra
           JOIN ${tbl("roles")} r ON r.id = ra.role_id
          WHERE ra.agent_id = $1 AND r.circle_id = $2`,
        [runCtx.agentId, discussion.circle_id],
      );
      const standing = new Set(rows.map((r) => r.role_type));
      const canBlock = standing.has("circle_lead") || standing.has("secretary") || standing.has("facilitator");
      if (!canBlock) {
        effectiveSignal = "support-with-objection";
      }
    } catch {
      effectiveSignal = "support-with-objection";
    }
  }

  // Auto-create linked tension for support-with-objection.
  let linkedTensionId: string | null = null;
  if (effectiveSignal === "support-with-objection" && discussion.circle_id) {
    try {
      const tensionId = randomUUID();
      await dbCtx.execute(
        `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type, metadata) VALUES ($1, $2, $3, $4, $5, 'operational', $6::jsonb)`,
        [
          tensionId,
          discussion.circle_id,
          runCtx.agentId,
          `[Discussion Objection] ${discussion.topic.slice(0, 100)}`,
          params.reason ?? "Objection raised during commit-to-support phase",
          JSON.stringify({ linked_discussion_id: discussion.id }),
        ],
      );
      linkedTensionId = tensionId;
    } catch {
      /* tensions table may not have metadata col on every install */
      try {
        const tensionId = randomUUID();
        await dbCtx.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, 'operational')`,
          [
            tensionId,
            discussion.circle_id,
            runCtx.agentId,
            `[Discussion Objection] ${discussion.topic.slice(0, 100)}`,
            (params.reason ?? "Objection") + ` (discussion=${discussion.id})`,
          ],
        );
        linkedTensionId = tensionId;
      } catch {
        /* noop */
      }
    }
  }

  // Upsert the commitment.
  await dbCtx.execute(
    `INSERT INTO public.discussion_commitments (discussion_id, agent_id, signal, reason, linked_tension_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (discussion_id, agent_id) DO UPDATE
       SET signal = EXCLUDED.signal, reason = EXCLUDED.reason, linked_tension_id = EXCLUDED.linked_tension_id, signaled_at = NOW()`,
    [params.discussionId, runCtx.agentId, effectiveSignal, params.reason ?? null, linkedTensionId],
  );
  try {
    await publishDiscussionEvent(discussion, {
      kind: "discussion-commitment-recorded",
      agentId: runCtx.agentId,
      signal: effectiveSignal,
      effective: effectiveSignal !== params.signal ? "downgraded" : "exact",
      linkedTensionId,
    });
  } catch {
    /* noop */
  }
  // Immediately check if threshold reached.
  const refreshed = await loadDiscussion(params.discussionId);
  if (refreshed && refreshed.phase === "awaiting_commitments") {
    try {
      await maybeConcludeViaCommitments(refreshed);
    } catch {
      /* noop */
    }
  }
  return {
    content: JSON.stringify({
      discussionId: params.discussionId,
      signal: effectiveSignal,
      downgraded: effectiveSignal !== params.signal,
      linkedTensionId,
    }, null, 2),
  };
}

interface RequestOneOnOneParams {
  withAgentId: string;
  topic?: string;
  initiateNow?: boolean;
}

async function runRequestOneOnOne(
  params: RequestOneOnOneParams,
  runCtx: ToolRunContextLike,
): Promise<ToolResult> {
  const topic = (params.topic && params.topic.trim().length > 0)
    ? params.topic.trim()
    : `1:1 between ${runCtx.agentId.slice(0, 8)} and ${params.withAgentId.slice(0, 8)}`;
  const result = await createDiscussion({
    circleId: null,
    topic,
    prompt: "This is a 1:1. Share what you need or want to discuss; the other party will respond.",
    rounds: 1,
    speakerMode: "roundtable",
    companyId: runCtx.companyId,
    initiatedByAgentId: runCtx.agentId,
    participantAgentIds: [runCtx.agentId, params.withAgentId],
  });
  if (!result.ok) return { content: result.error, error: "create_failed" };
  return {
    content: JSON.stringify({
      discussionId: result.discussion.id,
      contextId: result.discussion.a2a_context_id,
      speakerMode: result.discussion.speaker_mode,
      speakerOrder: result.discussion.speaker_order,
    }, null, 2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.15h-g1 — Steward / Concierge auto-healer.
//
// Runs every 5 minutes. Scans for 5 runtime pathologies and either heals
// idempotently (broken adapter, runaway loop, stuck discussion, stale commit
// phase) or escalates by raising an operational tension on the company's GCC
// Lead Link circle (high failure-rate, no healthy peer to copy from).
//
// Idempotency: every heal/escalation action checks `public.activity_log` for
// an existing entry with the same `[STEWARD:{kind}:{id}:{bucket}]` marker in
// `entity_id` before firing. This keeps re-runs within the same 5-min bucket
// (or 10-min / day bucket for loop / stuck / fail kinds) a no-op.
// ─────────────────────────────────────────────────────────────────────────────

interface StewardCounters { healed: number; escalated: number; checked: number }

/**
 * Find the company's GCC (root) circle. Used as escalation target when no
 * better circle is available.
 */
async function stewardFindGccCircle(companyId: string): Promise<string | null> {
  if (!dbCtx) return null;
  const rows = await dbCtx.query<{ id: string }>(
    `SELECT id FROM ${tbl("circles")} WHERE company_id = $1 AND parent_circle_id IS NULL LIMIT 1`,
    [companyId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Has the Steward already acted on this entity in this bucket?
 * Mirrors the accountability-scanner's idempotency-by-marker pattern but uses
 * `public.activity_log.entity_id` (no schema change required).
 */
async function stewardAlreadyActed(marker: string): Promise<boolean> {
  if (!dbCtx) return true; // fail safe
  const rows = await dbCtx.query<{ id: string }>(
    `SELECT id FROM public.activity_log WHERE entity_id = $1 LIMIT 1`,
    [marker],
  );
  return rows.length > 0;
}

/**
 * Raise an operational tension on the given circle, attributed to the
 * Steward. Severity is encoded in the description JSON since tensions table
 * has no severity column (mirrors accountability-scanner).
 */
async function raiseStewardTension(
  circleId: string,
  title: string,
  description: Record<string, unknown>,
  severity: "low" | "medium" | "high",
): Promise<string | null> {
  if (!dbCtx) return null;
  const tensionId = randomUUID();
  const body = JSON.stringify({ ...description, severity, source: "steward-healer" });
  try {
    await dbCtx.execute(
      `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, NULL, $3, $4, 'operational')`,
      [tensionId, circleId, title, body],
    );
    return tensionId;
  } catch (err) {
    console.warn("[holacracy] steward: raise tension failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Steward heal/escalate. See manifest job description for full scope.
 * Returns counters for observability.
 */
async function runStewardHealer(): Promise<StewardCounters> {
  if (!dbCtx) return { healed: 0, escalated: 0, checked: 0 };
  const counters: StewardCounters = { healed: 0, escalated: 0, checked: 0 };
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const bucket5min = Math.floor(now.getTime() / (5 * 60 * 1000));
  const bucket10min = Math.floor(now.getTime() / (10 * 60 * 1000));

  // ── 1. Broken adapter config ────────────────────────────────────────────
  // process-type agents missing `command`, or hermes_local missing
  // `hermesCommand`, or missing adapter_type. Heal: copy from a healthy peer
  // in the same company.
  try {
    const broken = await dbCtx.query<{
      id: string;
      company_id: string;
      name: string;
      adapter_type: string | null;
      adapter_config: Record<string, unknown> | null;
    }>(
      `SELECT id, company_id, name, adapter_type, adapter_config FROM public.agents
        WHERE status != 'deleted'
          AND (
            adapter_type IS NULL
            OR (adapter_type = 'process' AND (adapter_config IS NULL OR NOT (adapter_config ? 'command')))
            OR (adapter_type = 'hermes_local' AND (adapter_config IS NULL OR NOT (adapter_config ? 'hermesCommand')))
          )`,
      [],
    );
    counters.checked += broken.length;
    for (const agent of broken) {
      const marker = `[STEWARD:adapter:${agent.id}:${today}]`;
      if (await stewardAlreadyActed(marker)) continue;
      const peers = await dbCtx.query<{ adapter_type: string; adapter_config: Record<string, unknown> }>(
        `SELECT adapter_type, adapter_config FROM public.agents
          WHERE company_id = $1 AND id != $2 AND status != 'deleted'
            AND adapter_type = 'hermes_local'
            AND adapter_config ? 'hermesCommand'
          LIMIT 1`,
        [agent.company_id, agent.id],
      );
      if (peers.length > 0) {
        const peer = peers[0];
        await dbCtx.execute(
          `UPDATE public.agents SET adapter_type = $2, adapter_config = $3::jsonb, updated_at = NOW() WHERE id = $1`,
          [agent.id, peer.adapter_type, JSON.stringify(peer.adapter_config)],
        );
        counters.healed += 1;
        if (activityCtx) {
          await activityCtx.log({
            companyId: agent.company_id,
            message: `${marker} Healed broken adapter config for agent ${agent.name} by copying from healthy peer.`,
            entityType: "agent",
            entityId: marker,
            metadata: { agentId: agent.id, kind: "adapter", previousType: agent.adapter_type, newType: peer.adapter_type },
          });
        }
      } else {
        const gcc = await stewardFindGccCircle(agent.company_id);
        if (gcc) {
          await raiseStewardTension(
            gcc,
            `[Steward] Agent ${agent.name} has broken adapter config and no healthy peer to copy from`,
            { agent_id: agent.id, agent_name: agent.name, adapter_type: agent.adapter_type, scan_date: today },
            "medium",
          );
        }
        counters.escalated += 1;
        if (activityCtx) {
          await activityCtx.log({
            companyId: agent.company_id,
            message: `${marker} Escalated broken adapter — no healthy peer for agent ${agent.name}.`,
            entityType: "agent",
            entityId: marker,
            metadata: { agentId: agent.id, kind: "adapter-escalated" },
          });
        }
      }
    }
  } catch (err) {
    console.warn("[holacracy] steward: adapter pathology scan failed:", err instanceof Error ? err.message : String(err));
  }

  // ── 2. High failure rate ────────────────────────────────────────────────
  // >=5 failed heartbeat runs with the same error_code in the last 1h.
  // Heal: suspend agent + raise tension to GCC.
  try {
    const failBursts = await dbCtx.query<{
      agent_id: string;
      company_id: string;
      error_code: string;
      fail_count: number;
    }>(
      `SELECT hr.agent_id, hr.company_id, hr.error_code, COUNT(*)::int AS fail_count
         FROM public.heartbeat_runs hr
        WHERE hr.status = 'failed'
          AND hr.error_code IS NOT NULL
          AND hr.created_at >= NOW() - INTERVAL '1 hour'
        GROUP BY hr.agent_id, hr.company_id, hr.error_code
        HAVING COUNT(*) >= 5`,
      [],
    );
    counters.checked += failBursts.length;
    for (const burst of failBursts) {
      const marker = `[STEWARD:fail:${burst.agent_id}:${today}]`;
      if (await stewardAlreadyActed(marker)) continue;
      const agentRows = await dbCtx.query<{ name: string; status: string }>(
        `SELECT name, status FROM public.agents WHERE id = $1`,
        [burst.agent_id],
      );
      const agentName = agentRows[0]?.name ?? burst.agent_id;
      const agentStatus = agentRows[0]?.status ?? "unknown";
      if (agentStatus !== "suspended") {
        await dbCtx.execute(
          `UPDATE public.agents SET status = 'suspended', pause_reason = $2, paused_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [burst.agent_id, `[STEWARD] auto-suspended: ${burst.fail_count} failures in 1h with error_code=${burst.error_code}`],
        );
      }
      const gcc = await stewardFindGccCircle(burst.company_id);
      if (gcc) {
        await raiseStewardTension(
          gcc,
          `[Steward] Agent ${agentName} suspended — ${burst.fail_count} failures (${burst.error_code}) in last 1h`,
          {
            agent_id: burst.agent_id,
            agent_name: agentName,
            error_code: burst.error_code,
            fail_count: burst.fail_count,
            window: "1h",
            scan_date: today,
          },
          "high",
        );
      }
      counters.healed += 1;
      counters.escalated += 1;
      if (activityCtx) {
        await activityCtx.log({
          companyId: burst.company_id,
          message: `${marker} Suspended agent ${agentName} after ${burst.fail_count} failures (error_code=${burst.error_code}) in 1h.`,
          entityType: "agent",
          entityId: marker,
          metadata: { agentId: burst.agent_id, kind: "fail", errorCode: burst.error_code, failCount: burst.fail_count },
        });
      }
    }
  } catch (err) {
    console.warn("[holacracy] steward: failure-rate scan failed:", err instanceof Error ? err.message : String(err));
  }

  // ── 3. Runaway loop ─────────────────────────────────────────────────────
  // >=30 heartbeat_runs in the last 10 minutes regardless of wakeReason.
  // Heal: disable wake-on-demand in agents.metadata.policy + raise tension.
  try {
    const loops = await dbCtx.query<{ agent_id: string; company_id: string; run_count: number }>(
      `SELECT hr.agent_id, hr.company_id, COUNT(*)::int AS run_count
         FROM public.heartbeat_runs hr
        WHERE hr.created_at >= NOW() - INTERVAL '10 minutes'
        GROUP BY hr.agent_id, hr.company_id
        HAVING COUNT(*) >= 30`,
      [],
    );
    counters.checked += loops.length;
    for (const loop of loops) {
      const marker = `[STEWARD:loop:${loop.agent_id}:${bucket10min}]`;
      if (await stewardAlreadyActed(marker)) continue;
      const agentRows = await dbCtx.query<{ name: string }>(
        `SELECT name FROM public.agents WHERE id = $1`,
        [loop.agent_id],
      );
      const agentName = agentRows[0]?.name ?? loop.agent_id;
      // Patch metadata.policy.wakeOnDemand = false. jsonb_set creates the
      // intermediate `policy` object when missing (`true` last arg).
      await dbCtx.execute(
        `UPDATE public.agents
            SET metadata = jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{policy,wakeOnDemand}',
                  'false'::jsonb,
                  true
                ),
                updated_at = NOW()
          WHERE id = $1`,
        [loop.agent_id],
      );
      const gcc = await stewardFindGccCircle(loop.company_id);
      if (gcc) {
        await raiseStewardTension(
          gcc,
          `[Steward] Runaway loop detected — ${agentName} fired ${loop.run_count} heartbeats in 10min; wakeOnDemand disabled`,
          {
            agent_id: loop.agent_id,
            agent_name: agentName,
            run_count: loop.run_count,
            window: "10m",
            bucket: bucket10min,
          },
          "high",
        );
      }
      counters.healed += 1;
      counters.escalated += 1;
      if (activityCtx) {
        await activityCtx.log({
          companyId: loop.company_id,
          message: `${marker} Disabled wakeOnDemand for ${agentName} after ${loop.run_count} runs in 10min.`,
          entityType: "agent",
          entityId: marker,
          metadata: { agentId: loop.agent_id, kind: "loop", runCount: loop.run_count, bucket: bucket10min },
        });
      }
    }
  } catch (err) {
    console.warn("[holacracy] steward: runaway-loop scan failed:", err instanceof Error ? err.message : String(err));
  }

  // ── 4. Stuck discussion ─────────────────────────────────────────────────
  // phase='open', started >60min ago, no completed turn issue in last 30min.
  // Phase 1.15h-i #2 — Grove: when a `ratifier_agent_id` is set, ESCALATE to
  // the ratifier (transition to awaiting_commitments + spawn a decide-issue
  // assigned to them) instead of auto-deadlocking. Grove's pre-flight makes
  // the ratifier explicit; ignoring them would defeat the point. When no
  // ratifier is set, fall back to the legacy auto-deadlock behaviour.
  try {
    const stuck = await dbCtx.query<{
      id: string;
      company_id: string;
      circle_id: string | null;
      topic: string;
      a2a_context_id: string;
      ratifier_agent_id: string | null;
      decision_deadline: string | null;
    }>(
      `SELECT d.id, d.company_id, d.circle_id, d.topic,
              d.a2a_context_id, d.ratifier_agent_id,
              d.decision_deadline::text AS decision_deadline
         FROM public.circle_discussions d
        WHERE d.status = 'open'
          AND d.phase = 'open'
          AND d.started_at < NOW() - INTERVAL '60 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM public.issues i
             WHERE i.origin_id = d.id
               AND i.origin_kind = 'discussion:turn'
               AND i.status = 'done'
               AND i.completed_at >= NOW() - INTERVAL '30 minutes'
          )`,
      [],
    );
    counters.checked += stuck.length;
    for (const d of stuck) {
      const marker = `[STEWARD:stuck:${d.id}:${today}]`;
      if (await stewardAlreadyActed(marker)) continue;

      if (d.ratifier_agent_id) {
        // Grove escalation: hand the decision to the named ratifier instead
        // of deadlocking. Move phase → awaiting_commitments so their
        // commit-to-conclusion signal closes the discussion, and spawn a
        // decide-issue assigned to them with explicit instructions.
        await dbCtx.execute(
          `UPDATE public.circle_discussions
              SET phase = 'awaiting_commitments'
            WHERE id = $1 AND phase = 'open'`,
          [d.id],
        );
        const projectInfo = d.circle_id ? await resolveCircleProject(d.circle_id) : null;
        const projectId = projectInfo?.projectId ?? null;
        const issueId = randomUUID();
        const description = [
          `Discussion ${d.id} ("${d.topic.slice(0, 200)}") has stalled past its decision deadline (60min without progress).`,
          "",
          "As the named **ratifier** for this discussion (per Grove's pre-flight: \"Who will ratify or veto the decision?\"), you must decide it now.",
          "",
          "Reply via `holacracy-commit-to-conclusion` with either:",
          "- `support` — accept the discussion as it stands and conclude it.",
          "- `block` — veto with a written objection (forwarded to IDM).",
          "",
          d.decision_deadline ? `Original decision deadline: ${d.decision_deadline}` : "",
          "",
          `Discussion id: ${d.id}`,
          `Context id: ${d.a2a_context_id}`,
        ].filter((line) => line !== "").join("\n");
        const title = `[Ratifier] Decide stalled discussion: ${d.topic.slice(0, 120)}`;
        try {
          await dbCtx.execute(
            `INSERT INTO public.issues
               (id, company_id, project_id, title, description, status, kind, priority,
                assignee_agent_id, origin_kind, origin_id, origin_fingerprint,
                a2a_context_id)
             VALUES ($1, $2, $3, $4, $5, 'backlog', 'next_action', 'high', $6, $7, $8, 'ratifier-call', $9)`,
            [
              issueId,
              d.company_id,
              projectId,
              title,
              description,
              d.ratifier_agent_id,
              "discussion:ratifier-call",
              d.id,
              d.a2a_context_id,
            ],
          );
        } catch (insertErr) {
          // If the same fingerprint already exists (re-run), skip silently.
          const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (!/duplicate|unique/i.test(msg)) {
            console.warn("[holacracy] steward: ratifier-call insert failed:", msg);
          }
        }
        // Best-effort: publish a discussion event so the ratifier wakes.
        try {
          const refreshed = await loadDiscussion(d.id);
          if (refreshed) {
            await publishDiscussionEvent(refreshed, {
              kind: "discussion-ratifier-called",
              ratifierAgentId: d.ratifier_agent_id,
              issueId,
              reason: "stalled-60min",
            });
          }
        } catch {
          /* noop */
        }
        const targetCircle = d.circle_id ?? (await stewardFindGccCircle(d.company_id));
        if (targetCircle) {
          await raiseStewardTension(
            targetCircle,
            `[Steward] Discussion stalled → ratifier called: ${d.topic.slice(0, 120)}`,
            {
              discussion_id: d.id,
              topic: d.topic,
              reason: "stalled-open-phase",
              action: "escalated-to-ratifier",
              ratifier_agent_id: d.ratifier_agent_id,
              ratifier_issue_id: issueId,
              scan_date: today,
            },
            "medium",
          );
        }
        counters.escalated += 1;
        if (activityCtx) {
          await activityCtx.log({
            companyId: d.company_id,
            message: `${marker} Escalated stuck discussion to ratifier: ${d.topic.slice(0, 80)}`,
            entityType: "discussion",
            entityId: marker,
            metadata: {
              discussionId: d.id,
              kind: "stuck-ratifier-called",
              circleId: d.circle_id,
              ratifierAgentId: d.ratifier_agent_id,
              ratifierIssueId: issueId,
            },
          });
        }
        continue;
      }

      // No ratifier set — fall back to legacy auto-deadlock.
      // F6 — bridge to IDM before concluding so any support-with-objection /
      // block signals from agents don't get silently dropped. bridge is
      // idempotent + returns null if no objectors, so this is safe to call.
      try {
        const rows = await dbCtx.query<CircleDiscussionRow>(
          `SELECT * FROM public.circle_discussions WHERE id = $1`,
          [d.id],
        );
        if (rows[0]) {
          const bridge = await bridgeDiscussionToIdm(rows[0]);
          if (bridge) {
            console.log(
              `[holacracy] F6 — Steward bridged auto-concluded discussion ${d.id.slice(0, 8)} → IDM ${bridge.idmApprovalId.slice(0, 8)} (${bridge.objectionCount} objection(s))`,
            );
          }
        }
      } catch (err) {
        console.warn(
          "[holacracy] F6 — Steward → IDM bridge failed for stalled discussion",
          d.id.slice(0, 8),
          err instanceof Error ? err.message : String(err),
        );
      }
      await dbCtx.execute(
        `UPDATE public.circle_discussions
            SET phase = 'concluded',
                status = 'concluded',
                conclusion = $2,
                conclusion_kind = 'deadlocked',
                concluded_at = NOW()
          WHERE id = $1 AND status = 'open'`,
        [d.id, "[STEWARD] auto-concluded after 60min stall"],
      );
      // Cancel still-open turn issues so agents stop working on them.
      await dbCtx.execute(
        `UPDATE public.issues
            SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
          WHERE origin_id = $1
            AND origin_kind IN ('discussion:turn', 'discussion:summary')
            AND status IN ('backlog', 'todo', 'in_progress')`,
        [d.id],
      );
      const targetCircle = d.circle_id ?? (await stewardFindGccCircle(d.company_id));
      if (targetCircle) {
        await raiseStewardTension(
          targetCircle,
          `[Steward] Discussion auto-concluded after 60min stall: ${d.topic.slice(0, 120)}`,
          { discussion_id: d.id, topic: d.topic, reason: "stalled-open-phase", scan_date: today },
          "medium",
        );
      }
      counters.healed += 1;
      counters.escalated += 1;
      if (activityCtx) {
        await activityCtx.log({
          companyId: d.company_id,
          message: `${marker} Auto-concluded stuck discussion: ${d.topic.slice(0, 80)}`,
          entityType: "discussion",
          entityId: marker,
          metadata: { discussionId: d.id, kind: "stuck", circleId: d.circle_id },
        });
      }
    }
  } catch (err) {
    console.warn("[holacracy] steward: stuck-discussion scan failed:", err instanceof Error ? err.message : String(err));
  }

  // ── 4b. F8 — Per-phase IDM deadline scanner ────────────────────────────
  // The IDM 6-phase pipeline (F3) advances only when every outstanding turn
  // issue for the current phase is `done` or `cancelled`. If one or more
  // agents fail to take their turn within the per-phase deadline, the
  // discussion stalls forever. This scanner cancels overdue turn issues so
  // F3 can advance on the next tick — preventing a single stalled agent
  // from blocking the whole circle.
  try {
    const PHASE_DEADLINES_HOURS: Record<string, number> = {
      proposal: 4,
      clarifying_questions: 2,
      reactions: 4,
      amend: 2,
      objections: 4,
      integration: 8,
    };
    const overdue = await dbCtx.query<{
      id: string;
      company_id: string;
      circle_id: string | null;
      phase: string;
      topic: string;
      hours_in_phase: number;
    }>(
      `SELECT d.id, d.company_id, d.circle_id, d.phase, d.topic,
              EXTRACT(EPOCH FROM (NOW() - d.updated_at)) / 3600.0 AS hours_in_phase
         FROM public.circle_discussions d
        WHERE d.status = 'open'
          AND d.phase = ANY($1::text[])`,
      [Object.keys(PHASE_DEADLINES_HOURS)],
    );
    counters.checked += overdue.length;
    for (const d of overdue) {
      const deadline = PHASE_DEADLINES_HOURS[d.phase];
      if (deadline == null || Number(d.hours_in_phase) < deadline) continue;
      const marker = `[STEWARD:phase-deadline:${d.id}:${d.phase}:${today}]`;
      if (await stewardAlreadyActed(marker)) continue;
      // Cancel the still-open turn issues for the CURRENT phase so the F3
      // advancer's countPhaseTurns sees stats.finished == stats.total on its
      // next tick. We leave the discussion's phase alone — F3 will advance it.
      const phaseFingerprint = `idm-${d.phase}`;
      await dbCtx.execute(
        `UPDATE public.issues
            SET status = 'cancelled', updated_at = NOW()
          WHERE origin_kind = 'discussion:turn'
            AND origin_id = $1
            AND origin_fingerprint = $2
            AND status IN ('backlog', 'todo', 'in_progress')`,
        [d.id, phaseFingerprint],
      );
      counters.healed += 1;
      if (activityCtx) {
        await activityCtx.log({
          companyId: d.company_id,
          message: `${marker} Phase-deadline scanner cancelled overdue ${d.phase} turns on discussion ${d.id.slice(0, 8)} (${d.hours_in_phase.toFixed(1)}h > ${deadline}h limit); F3 will advance next tick.`,
          entityType: "discussion",
          entityId: marker,
          metadata: {
            discussionId: d.id,
            phase: d.phase,
            hoursInPhase: Number(d.hours_in_phase),
            deadlineHours: deadline,
            kind: "phase-deadline-cancellation",
          },
        });
      }
    }
  } catch (err) {
    console.warn("[holacracy] steward: phase-deadline scan failed:", err instanceof Error ? err.message : String(err));
  }

  // ── 5. Stale awaiting_commitments ──────────────────────────────────────
  // phase='awaiting_commitments' with no new commit signal in 24h.
  try {
    const stale = await dbCtx.query<{ id: string; company_id: string; circle_id: string | null; topic: string }>(
      `SELECT d.id, d.company_id, d.circle_id, d.topic
         FROM public.circle_discussions d
        WHERE d.status = 'open'
          AND d.phase = 'awaiting_commitments'
          AND NOT EXISTS (
            SELECT 1 FROM public.discussion_commitments dc
             WHERE dc.discussion_id = d.id
               AND dc.signaled_at >= NOW() - INTERVAL '24 hours'
          )`,
      [],
    );
    counters.checked += stale.length;
    for (const d of stale) {
      const marker = `[STEWARD:stale-commit:${d.id}:${today}]`;
      if (await stewardAlreadyActed(marker)) continue;
      // F6 — bridge to IDM before concluding (idempotent; null if no objectors).
      try {
        const rows = await dbCtx.query<CircleDiscussionRow>(
          `SELECT * FROM public.circle_discussions WHERE id = $1`,
          [d.id],
        );
        if (rows[0]) {
          const bridge = await bridgeDiscussionToIdm(rows[0]);
          if (bridge) {
            console.log(
              `[holacracy] F6 — Steward bridged stale-commit discussion ${d.id.slice(0, 8)} → IDM ${bridge.idmApprovalId.slice(0, 8)} (${bridge.objectionCount} objection(s))`,
            );
          }
        }
      } catch (err) {
        console.warn(
          "[holacracy] F6 — Steward → IDM bridge failed for stale-commit discussion",
          d.id.slice(0, 8),
          err instanceof Error ? err.message : String(err),
        );
      }
      await dbCtx.execute(
        `UPDATE public.circle_discussions
            SET phase = 'concluded',
                status = 'concluded',
                conclusion = $2,
                conclusion_kind = 'deadlocked',
                concluded_at = NOW()
          WHERE id = $1 AND status = 'open'`,
        [d.id, "[STEWARD] auto-concluded — no commitment signals in 24h"],
      );
      const targetCircle = d.circle_id ?? (await stewardFindGccCircle(d.company_id));
      if (targetCircle) {
        await raiseStewardTension(
          targetCircle,
          `[Steward] Discussion auto-concluded — no commitments in 24h: ${d.topic.slice(0, 120)}`,
          { discussion_id: d.id, topic: d.topic, reason: "stale-awaiting-commitments", scan_date: today },
          "medium",
        );
      }
      counters.healed += 1;
      counters.escalated += 1;
      if (activityCtx) {
        await activityCtx.log({
          companyId: d.company_id,
          message: `${marker} Auto-concluded stale awaiting-commitments discussion: ${d.topic.slice(0, 80)}`,
          entityType: "discussion",
          entityId: marker,
          metadata: { discussionId: d.id, kind: "stale-commit", circleId: d.circle_id },
        });
      }
    }
  } catch (err) {
    console.warn("[holacracy] steward: stale-commitments scan failed:", err instanceof Error ? err.message : String(err));
  }

  // Suppress unused-var warning when no buckets ever apply (e.g. only daily
  // pathologies fire). `bucket5min` is reserved for finer-grained markers.
  void bucket5min;

  return counters;
}

const plugin = definePlugin({
  async setup(ctx) {
    dbCtx = ctx.db;
    httpCtx = ctx.http;
    approvalsCtx = ctx.approvals;
    issuesCtx = ctx.issues;
    mqttCtx = ctx.mqtt;
    activityCtx = ctx.activity;
    // Seed global domain registry (idempotent, runs once per plugin start)
    try {
      await seedDefaultDomainRegistry();
    } catch (err) {
      // Migration may not have applied yet; log but don't crash plugin
      console.warn("[holacracy] domain_registry seed skipped:", err instanceof Error ? err.message : String(err));
    }

    // Seed pre-defined workflow templates on each GCC (root circle)
    try {
      const gccs = await dbCtx!.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM ${tbl("circles")} WHERE parent_circle_id IS NULL`,
      );
      for (const gcc of gccs) {
        const existing = await dbCtx!.query<{ count: number }>(
          `SELECT COUNT(*)::int as count FROM ${tbl("workflows")} WHERE circle_id=$1`,
          [gcc.id],
        );
        if ((existing[0]?.count ?? 0) > 0) continue;
        const seedWorkflows = [
          {
            name: "L&D Intelligence Cycle",
            description: "End-to-end cycle for capturing, processing, and distributing organizational learning and intelligence.",
            trigger: "tension raised with L&D or intelligence tag",
            steps: [
              { stepNumber: 1, roleName: "Intelligence Scout", title: "Identify & Capture Signal", inputs: ["market feed", "team observations"], outputs: ["raw signal log"], slaDays: 2, blocksNextStep: true },
              { stepNumber: 2, roleName: "Analyst", title: "Synthesize & Validate", inputs: ["raw signal log"], outputs: ["validated insight brief"], slaDays: 3, blocksNextStep: true },
              { stepNumber: 3, roleName: "Knowledge Curator", title: "Format & Index", inputs: ["validated insight brief"], outputs: ["indexed knowledge entry"], slaDays: 1, blocksNextStep: true },
              { stepNumber: 4, roleName: "Circle Lead", title: "Broadcast & Archive", inputs: ["indexed knowledge entry"], outputs: ["distribution record"], slaDays: 1, blocksNextStep: false },
            ],
          },
          {
            name: "Feature Request Pipeline",
            description: "Standard pipeline for processing inbound feature requests from idea to backlog-ready specification.",
            trigger: "new feature request submitted",
            steps: [
              { stepNumber: 1, roleName: "Product Intake", title: "Triage & Log", inputs: ["raw request"], outputs: ["triaged request with priority score"], slaDays: 1, blocksNextStep: true },
              { stepNumber: 2, roleName: "Product Designer", title: "Define & Mockup", inputs: ["triaged request"], outputs: ["design brief or wireframe"], slaDays: 5, blocksNextStep: true },
              { stepNumber: 3, roleName: "Tech Lead", title: "Feasibility Review", inputs: ["design brief"], outputs: ["technical assessment"], slaDays: 3, blocksNextStep: true },
              { stepNumber: 4, roleName: "Product Lead", title: "Acceptance & Backlog Entry", inputs: ["technical assessment", "design brief"], outputs: ["backlog issue"], slaDays: 1, blocksNextStep: false },
            ],
          },
          {
            name: "Board Task Routing",
            description: "Governance workflow for routing board-level decisions, approvals, and strategic tasks to the right circles.",
            trigger: "board task or approval request created",
            steps: [
              { stepNumber: 1, roleName: "Secretary", title: "Classify & Tag", inputs: ["board task"], outputs: ["classified task with circle tag"], slaDays: 1, blocksNextStep: true },
              { stepNumber: 2, roleName: "Circle Lead", title: "Assign to Role", inputs: ["classified task"], outputs: ["assigned task"], slaDays: 1, blocksNextStep: true },
              { stepNumber: 3, roleName: "Assignee", title: "Execute & Report", inputs: ["assigned task"], outputs: ["completion report"], slaDays: 7, blocksNextStep: true },
              { stepNumber: 4, roleName: "Facilitator", title: "Close & Archive", inputs: ["completion report"], outputs: ["archived record"], slaDays: 1, blocksNextStep: false },
            ],
          },
        ];
        for (const wf of seedWorkflows) {
          const newWfId = crypto.randomUUID();
          await dbCtx!.execute(
            `INSERT INTO ${tbl("workflows")} (id, circle_id, name, description, trigger) VALUES ($1,$2,$3,$4,$5)`,
            [newWfId, gcc.id, wf.name, wf.description, wf.trigger],
          );
          for (const s of wf.steps) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("workflow_steps")} (workflow_id, step_number, role_name, title, inputs, outputs, sla_days, blocks_next_step) VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7,$8)`,
              [newWfId, s.stepNumber, s.roleName, s.title, s.inputs, s.outputs, s.slaDays, s.blocksNextStep],
            );
          }
        }
      }
    } catch (err) {
      console.warn("[holacracy] workflow seed skipped:", err instanceof Error ? err.message : String(err));
    }

    // Seed GCC policy: Intra-Circle Decomposition (references workflow templates)
    try {
      const gccs = await dbCtx!.query<{ id: string }>(
        `SELECT id FROM ${tbl("circles")} WHERE parent_circle_id IS NULL`,
      );
      for (const gcc of gccs) {
        const existing = await dbCtx!.query<{ count: number }>(
          `SELECT COUNT(*)::int as count FROM ${tbl("policies")} WHERE circle_id=$1 AND title='Intra-Circle Decomposition'`,
          [gcc.id],
        );
        if ((existing[0]?.count ?? 0) > 0) continue;
        await dbCtx!.execute(
          `INSERT INTO ${tbl("policies")} (id, circle_id, title, description) VALUES ($1,$2,$3,$4)`,
          [
            crypto.randomUUID(),
            gcc.id,
            "Intra-Circle Decomposition",
            "When an issue spans multiple roles, the Circle Lead MUST decompose it using a Workflow Template (see Workflows tab) rather than assigning all steps to one agent. " +
            "Each workflow step becomes a sub-issue assigned to the appropriate role. " +
            "Available templates: L&D Intelligence Cycle, Feature Request Pipeline, Board Task Routing. " +
            "Anti-pattern: heroic leadership where one agent owns all steps outside their role. " +
            "Authority: Circle Leads may create new workflow templates; role-agents may propose templates via tension.",
          ],
        );
      }
    } catch (err) {
      console.warn("[holacracy] GCC policy seed skipped:", err instanceof Error ? err.message : String(err));
    }

    ctx.data.register("circles-tree", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      const circles = await ctx.db.query<Circle>(
        `SELECT * FROM ${tbl("circles")} WHERE company_id = $1 ORDER BY parent_circle_id NULLS FIRST, name`,
        [companyId],
      );
      const result = [];
      for (const c of circles) {
        const roles = await ctx.db.query<Role>(
          `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
          [c.id],
        );
        result.push({ ...c, roles });
      }
      return result;
    });

    ctx.data.register("tensions-cross-circle", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      return ctx.db.query<Tension & { circle_name: string; source_circle_name: string }>(
        `SELECT t.*, c.name as circle_name FROM ${tbl("tensions")} t JOIN ${tbl("circles")} c ON c.id = t.circle_id WHERE c.company_id = $1 AND t.title LIKE '[Forwarded]%' ORDER BY t.created_at DESC LIMIT 20`,
        [companyId],
      );
    });

    ctx.data.register("circle-governance", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return null;
      const strategies = await ctx.db.query(
        `SELECT s.*, a.name as set_by_name FROM ${tbl("strategies")} s LEFT JOIN public.agents a ON a.id = s.set_by WHERE s.circle_id = $1 AND s.active = true ORDER BY s.created_at DESC`,
        [circleId],
      );
      const policies = await ctx.db.query(
        `SELECT * FROM ${tbl("policies")} WHERE circle_id = $1 ORDER BY created_at DESC`,
        [circleId],
      );
      const checklists = await ctx.db.query(
        `SELECT cl.*, r.name as role_name FROM ${tbl("checklists")} cl LEFT JOIN ${tbl("roles")} r ON r.id = cl.role_id WHERE cl.circle_id = $1 ORDER BY cl.frequency, cl.created_at`,
        [circleId],
      );
      const metrics = await ctx.db.query(
        `SELECT m.*, r.name as role_name FROM ${tbl("metrics")} m LEFT JOIN ${tbl("roles")} r ON r.id = m.role_id WHERE m.circle_id = $1 ORDER BY m.frequency, m.created_at`,
        [circleId],
      );
      return { strategies, policies, checklists, metrics };
    });

    ctx.data.register("governance-summary", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return null;
      const circles = await ctx.db.query(
        `SELECT c.id, c.name, c.purpose, c.domains, c.color FROM ${tbl("circles")} c WHERE c.company_id = $1 ORDER BY c.parent_circle_id NULLS FIRST, c.name`,
        [companyId],
      );
      const result = [];
      for (const c of circles) {
        const stratCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("strategies")} WHERE circle_id = $1 AND active = true`, [c.id]);
        const polCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("policies")} WHERE circle_id = $1`, [c.id]);
        const clCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("checklists")} WHERE circle_id = $1`, [c.id]);
        const metCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("metrics")} WHERE circle_id = $1`, [c.id]);
        const tensionCount = await ctx.db.query(`SELECT COUNT(*)::int as count FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open'`, [c.id]);
        result.push({
          ...c,
          strategiesCount: stratCount[0]?.count ?? 0,
          policiesCount: polCount[0]?.count ?? 0,
          checklistsCount: clCount[0]?.count ?? 0,
          metricsCount: metCount[0]?.count ?? 0,
          openTensionsCount: tensionCount[0]?.count ?? 0,
        });
      }
      return result;
    });

    ctx.data.register("agent-role", async (params) => {
      const agentId = params.agentId as string;
      if (!agentId) return null;
      const assignments = await ctx.db.query(
        `SELECT ra.*, r.name as role_name, r.purpose as role_purpose, r.role_type, r.accountabilities, r.domains, c.id as circle_id, c.name as circle_name, c.purpose as circle_purpose FROM ${tbl("role_assignments")} ra JOIN ${tbl("roles")} r ON r.id = ra.role_id JOIN ${tbl("circles")} c ON c.id = r.circle_id WHERE ra.agent_id = $1`,
        [agentId],
      );
      if (assignments.length === 0) return null;
      const assignment = assignments[0];
      const checklists = await ctx.db.query(
        `SELECT * FROM ${tbl("checklists")} WHERE role_id = $1 ORDER BY frequency, created_at`,
        [assignment.role_id],
      );
      const metrics = await ctx.db.query(
        `SELECT * FROM ${tbl("metrics")} WHERE role_id = $1 ORDER BY frequency, created_at`,
        [assignment.role_id],
      );
      const tensions = await ctx.db.query(
        `SELECT * FROM ${tbl("tensions")} WHERE circle_id = $1 AND source_agent_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 5`,
        [assignment.circle_id, agentId],
      );
      return { ...assignment, checklists, metrics, tensions };
    });

    ctx.data.register("circle-audit-log", async (params) => {
      const circleId = params.circleId as string;
      if (!circleId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(circleId)) return [];
      return ctx.db.query(
        `SELECT al.*, a.name as agent_name FROM ${tbl("audit_log")} al LEFT JOIN public.agents a ON a.id = al.agent_id WHERE al.circle_id = $1 ORDER BY al.created_at DESC LIMIT 20`,
        [circleId],
      );
    });

    ctx.data.register("tensions-board", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return { tensions: [], circles: [] };
      const tensions = await ctx.db.query(
        `SELECT t.*, c.name as circle_name, a.name as source_agent_name
         FROM ${tbl("tensions")} t
         JOIN ${tbl("circles")} c ON c.id = t.circle_id
         LEFT JOIN public.agents a ON a.id = t.source_agent_id
         WHERE c.company_id = $1
         ORDER BY t.created_at DESC`,
        [companyId],
      );
      const circles = await ctx.db.query(
        `SELECT id, name FROM ${tbl("circles")} WHERE company_id = $1 ORDER BY name`,
        [companyId],
      );
      return { tensions, circles };
    });

    ctx.data.register("circle-workflows", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      const workflows = await ctx.db.query<{
        id: string; circle_id: string; name: string; description: string | null; trigger: string | null; created_at: string; updated_at: string;
      }>(`SELECT * FROM ${tbl("workflows")} WHERE circle_id = $1 ORDER BY name`, [circleId]);
      const result = [];
      for (const w of workflows) {
        const steps = await ctx.db.query<{
          id: string; workflow_id: string; step_number: number; role_name: string; title: string;
          inputs: string[]; outputs: string[]; sla_days: number; blocks_next_step: boolean;
        }>(`SELECT * FROM ${tbl("workflow_steps")} WHERE workflow_id = $1 ORDER BY step_number`, [w.id]);
        result.push({ ...w, steps });
      }
      return result;
    });

    ctx.data.register("issue-workflow-progress", async (params) => {
      const issueId = params.issueId as string;
      if (!issueId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) return null;
      // Find sub-issues created by workflow apply, keyed by originId = "<workflowId>:step-N"
      const subIssues = await ctx.db.query<{
        id: string; title: string; status: string; origin_id: string | null; origin_kind: string | null;
      }>(
        `SELECT id, title, status, origin_id, origin_kind FROM public.issues WHERE parent_id = $1 AND origin_kind = 'plugin:paperclipai.plugin-holacracy:workflow-step' ORDER BY created_at`,
        [issueId],
      );
      if (!subIssues.length) return null;
      // Extract workflowId from first step originId "<workflowId>:step-N"
      const firstOriginId = subIssues[0]?.origin_id ?? "";
      const workflowId = firstOriginId.split(":step-")[0] ?? "";
      let workflowName = workflowId;
      if (workflowId) {
        const wf = await ctx.db.query<{ name: string }>(`SELECT name FROM ${tbl("workflows")} WHERE id = $1`, [workflowId]);
        if (wf.length) workflowName = wf[0].name;
      }
      const steps = subIssues.map((si) => {
        const stepNum = parseInt((si.origin_id ?? "").split(":step-")[1] ?? "0", 10);
        return { stepNumber: stepNum, issueId: si.id, title: si.title, status: si.status };
      });
      return { workflowId, workflowName, steps };
    });

    // ── Workflow CRUD actions (called from UI via usePluginAction) ─────────────
    ctx.actions.register("workflow.create", async (params) => {
      const { circleId, name, description, trigger } = params as {
        circleId: string; name: string; description?: string; trigger?: string;
      };
      const newId = crypto.randomUUID();
      await dbCtx!.execute(
        `INSERT INTO ${tbl("workflows")} (id, circle_id, name, description, trigger) VALUES ($1,$2,$3,$4,$5)`,
        [newId, circleId, name, description ?? null, trigger ?? null],
      );
      return { id: newId };
    });

    ctx.actions.register("workflow.update", async (params) => {
      const { workflowId, name, description, trigger } = params as {
        workflowId: string; name?: string; description?: string; trigger?: string;
      };
      await dbCtx!.execute(
        `UPDATE ${tbl("workflows")} SET name=COALESCE($2,name), description=COALESCE($3,description), trigger=COALESCE($4,trigger), updated_at=NOW() WHERE id=$1`,
        [workflowId, name ?? null, description ?? null, trigger ?? null],
      );
      return { ok: true };
    });

    ctx.actions.register("workflow.delete", async (params) => {
      const { workflowId } = params as { workflowId: string };
      await dbCtx!.execute(`DELETE FROM ${tbl("workflow_steps")} WHERE workflow_id=$1`, [workflowId]);
      await dbCtx!.execute(`DELETE FROM ${tbl("workflows")} WHERE id=$1`, [workflowId]);
      return { ok: true };
    });

    ctx.actions.register("workflow.step.upsert", async (params) => {
      const { workflowId, stepNumber, roleName, title, inputs, outputs, slaDays, blocksNextStep } = params as {
        workflowId: string; stepNumber: number; roleName: string; title: string;
        inputs: string[]; outputs: string[]; slaDays: number; blocksNextStep: boolean;
      };
      const existing = await dbCtx!.query<{ id: string }>(
        `SELECT id FROM ${tbl("workflow_steps")} WHERE workflow_id=$1 AND step_number=$2`,
        [workflowId, stepNumber],
      );
      if (existing.length > 0) {
        await dbCtx!.execute(
          `UPDATE ${tbl("workflow_steps")} SET role_name=$3, title=$4, inputs=$5::text[], outputs=$6::text[], sla_days=$7, blocks_next_step=$8 WHERE workflow_id=$1 AND step_number=$2`,
          [workflowId, stepNumber, roleName, title, inputs, outputs, slaDays, blocksNextStep],
        );
        return { id: existing[0].id };
      } else {
        const newStepId = crypto.randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("workflow_steps")} (id, workflow_id, step_number, role_name, title, inputs, outputs, sla_days, blocks_next_step) VALUES ($1,$2,$3,$4,$5,$6::text[],$7::text[],$8,$9)`,
          [newStepId, workflowId, stepNumber, roleName, title, inputs, outputs, slaDays, blocksNextStep],
        );
        return { id: newStepId };
      }
    });

    ctx.actions.register("workflow.step.delete", async (params) => {
      const { stepId } = params as { stepId: string };
      await dbCtx!.execute(`DELETE FROM ${tbl("workflow_steps")} WHERE id=$1`, [stepId]);
      return { ok: true };
    });

    ctx.tools.register(
      TOOL_NAMES.getCircle,
      { displayName: "Get Holacracy Circle", description: "Get a circle's structure including purpose, roles, sub-circles, and policies", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const detail = await queryCircleDetail((params as { circleId: string }).circleId);
        if (!detail) return { content: "Circle not found", error: "not found" };
        return { content: JSON.stringify(detail, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.getRole,
      { displayName: "Get Holacracy Role", description: "Get a role's details including purpose, accountabilities, domains, and assignments", parametersSchema: { type: "object", properties: { roleId: { type: "string" } }, required: ["roleId"] } },
      async (params): Promise<ToolResult> => {
        const { roleId } = params as { roleId: string };
        const roles = await dbCtx!.query<Role>(`SELECT * FROM ${tbl("roles")} WHERE id = $1`, [roleId]);
        if (roles.length === 0) return { content: "Role not found", error: "not found" };
        const assignments = await dbCtx!.query<{ agent_id: string; agent_name: string; focus_ap: number }>(
          `SELECT ra.agent_id, a.name as agent_name, ra.focus_ap FROM ${tbl("role_assignments")} ra JOIN public.agents a ON a.id = ra.agent_id WHERE ra.role_id = $1`,
          [roleId],
        );
        return { content: JSON.stringify({ role: roles[0], filledBy: assignments }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listTensions,
      { displayName: "List Circle Tensions", description: "List open tensions in a circle, optionally filtered by type", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, type: { type: "string", enum: ["operational", "governance", "all"] } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId, type: tt } = params as { circleId: string; type?: string };
        const filter = tt && tt !== "all" ? " AND tension_type = $2" : "";
        const args = filter ? [circleId, tt] : [circleId];
        const tensions = await dbCtx!.query<Tension>(
          `SELECT * FROM ${tbl("tensions")} WHERE circle_id = $1 AND status = 'open'${filter} ORDER BY created_at DESC`,
          args,
        );
        return { content: JSON.stringify({ tensions, count: tensions.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.raiseTension,
      { displayName: "Raise Tension", description: "Raise a tension in a circle for processing in the next meeting", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, type: { type: "string", enum: ["operational", "governance"] } }, required: ["circleId", "title", "description", "type"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, title, description, type: tensionType } = params as { circleId: string; title: string; description: string; type: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, circleId, runCtx.agentId ?? null, title, description, tensionType],
        );
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
          [runCtx.companyId, runCtx.agentId ?? null, circleId, JSON.stringify({ tensionId: id, title, type: tensionType })],
        );

        // Trigger A: governance tension → auto-create 3-of-3 async approval
        let approvalId: string | undefined;
        if (tensionType === "governance") {
          const approvalResult = await createGovernanceApproval({
            companyId: runCtx.companyId,
            tensionId: id,
            title,
            description: description ?? null,
            requestedByAgentId: runCtx.agentId ?? null,
          });
          if (approvalResult) {
            approvalId = approvalResult.approvalId;
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'governance-approval-created', $3)`,
              [runCtx.companyId, circleId, JSON.stringify({ tensionId: id, approvalId: approvalResult.approvalId })],
            );
          }
        }

        return {
          content: JSON.stringify({
            tensionId: id,
            status: "open",
            message: `Tension raised: "${title}" (${tensionType})`,
            ...(approvalId ? { approvalId, approvalStatus: "pending" } : {}),
          }),
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.checkAuthority,
      { displayName: "Check Authority", description: "Check if an action is within your role's authority scope", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, roleId: { type: "string" }, proposedAction: { type: "string", enum: ["assign-role", "update-policy", "create-project", "escalate", "set-strategy", "modify-governance", "assign-sub-circle-lead-link"] } }, required: ["circleId", "roleId", "proposedAction"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, roleId, proposedAction } = params as { circleId: string; roleId: string; proposedAction: string };
        const roles = await dbCtx!.query<Role>(`SELECT * FROM ${tbl("roles")} WHERE id = $1 AND circle_id = $2`, [roleId, circleId]);
        if (roles.length === 0) return { content: JSON.stringify({ authorized: false, reason: "Role not found in this circle" }) };
        const role = roles[0];
        const authorityMap: Record<string, string[]> = {
          "circle_lead": ["assign-role", "create-project", "set-strategy", "escalate", "assign-sub-circle-lead-link"],
          "facilitator": ["escalate"],
          "secretary": ["escalate"],
          "circle_rep": ["escalate"],
        };
        const structuralActions = ["update-policy", "modify-governance"];
        if (structuralActions.includes(proposedAction)) {
          return { content: JSON.stringify({ authorized: false, reason: "Structural changes require governance process. Raise a governance tension instead.", escalateTo: "governance-tension" }) };
        }
        const allowed = authorityMap[role.role_type] ?? [];
        // Concept 9: cross-circle Lead Link assignment authority — caller must hold
        // a Lead Link role in the parent circle of the target.
        if (proposedAction === "assign-sub-circle-lead-link") {
          if (!allowed.includes(proposedAction)) {
            return { content: JSON.stringify({ authorized: false, reason: `Action "${proposedAction}" is not within ${role.role_type} authority. Only a Circle Lead in the parent circle may assign a sub-circle Lead Link.`, escalateTo: "parent-circle-lead" }) };
          }
          // The role asking authority must be a circle_lead in some parent of the target circle.
          const callerIsParentLead = await isAgentLeadLinkInAncestor(runCtx.agentId ?? null, circleId);
          if (!callerIsParentLead.ok) {
            return { content: JSON.stringify({ authorized: false, reason: callerIsParentLead.reason, code: "parent_lead_link_required", escalateTo: "parent-circle-lead" }) };
          }
          return { content: JSON.stringify({ authorized: true, reason: "Caller holds Lead Link in a parent circle." }) };
        }
        if (allowed.includes(proposedAction)) {
          return { content: JSON.stringify({ authorized: true, reason: `Action "${proposedAction}" is within ${role.role_type} authority scope` }) };
        }
        return { content: JSON.stringify({ authorized: false, reason: `Action "${proposedAction}" is not within ${role.role_type} authority. Consider escalating.`, escalateTo: "circle-lead" }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.logAction,
      { displayName: "Log Action", description: "Log an action taken in your role for the audit trail", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, actionType: { type: "string", enum: ["decision", "delegation", "tension-raised", "escalation", "role-change", "policy-change"] }, detail: { type: "string" } }, required: ["circleId", "actionType", "detail"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, actionType, detail } = params as { circleId: string; actionType: string; detail: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (id, company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, (SELECT company_id FROM ${tbl("circles")} WHERE id = $2), $3, $2, $4, $5)`,
          [id, circleId, runCtx.agentId ?? null, actionType, JSON.stringify({ detail })],
        );
        return { content: JSON.stringify({ logged: true, id, actionType, detail }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.forwardTension,
      { displayName: "Forward Tension", description: "Forward a tension from your circle to the parent circle (Circle Rep only)", parametersSchema: { type: "object", properties: { tensionId: { type: "string" }, context: { type: "string" } }, required: ["tensionId", "context"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { tensionId, context } = params as { tensionId: string; context: string };
        const tensions = await dbCtx!.query<Tension>(`SELECT * FROM ${tbl("tensions")} WHERE id = $1`, [tensionId]);
        if (tensions.length === 0) return { content: "Tension not found", error: "not found" };
        const sourceTension = tensions[0];
        const circles = await dbCtx!.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [sourceTension.circle_id]);
        if (!circles[0]?.parent_circle_id) return { content: "Circle has no parent circle to forward to", error: "no parent" };
        const forwardedId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [forwardedId, circles[0].parent_circle_id, runCtx.agentId ?? sourceTension.source_agent_id, `[Forwarded] ${sourceTension.title}`, `${context}\n\n---\nOriginal tension from ${circles[0].name}: ${sourceTension.description ?? ""}`, sourceTension.tension_type],
        );
        await dbCtx!.execute(`UPDATE ${tbl("tensions")} SET status = 'processing' WHERE id = $1`, [tensionId]);
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ((SELECT company_id FROM ${tbl("circles")} WHERE id = $1), $2, $1, 'tension-forwarded', $3)`,
          [sourceTension.circle_id, runCtx.agentId ?? null, JSON.stringify({ originalTensionId: tensionId, forwardedTensionId: forwardedId, context })],
        );
        return { content: JSON.stringify({ forwardedTensionId: forwardedId, targetCircleId: circles[0].parent_circle_id, status: "forwarded" }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listPolicies,
      { displayName: "List Policies", description: "List policies governing a circle's domains", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId } = params as { circleId: string };
        const policies = await dbCtx!.query(`SELECT * FROM ${tbl("policies")} WHERE circle_id = $1 ORDER BY created_at DESC`, [circleId]);
        return { content: JSON.stringify({ policies, count: policies.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.setStrategy,
      { displayName: "Set Strategy", description: "Set a strategy for your circle (Circle Lead only)", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, text: { type: "string" } }, required: ["circleId", "text"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, text } = params as { circleId: string; text: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("strategies")} (id, circle_id, text, set_by) VALUES ($1, $2, $3, $4)`,
          [id, circleId, text, runCtx.agentId ?? null],
        );
        return { content: JSON.stringify({ strategyId: id, text, status: "active" }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.reportChecklist,
      { displayName: "Report Checklist", description: "Report check/no-check on your recurring checklist items", parametersSchema: { type: "object", properties: { checklistId: { type: "string" }, checked: { type: "boolean" }, periodDate: { type: "string" } }, required: ["checklistId", "checked", "periodDate"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { checklistId, checked, periodDate } = params as { checklistId: string; checked: boolean; periodDate: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("checklist_responses")} (id, checklist_id, agent_id, checked, period_date) VALUES ($1, $2, $3, $4, $5)`,
          [id, checklistId, runCtx.agentId ?? null, checked, periodDate],
        );
        return { content: JSON.stringify({ reported: true, checklistId, checked, periodDate }) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.reportMetric,
      { displayName: "Report Metric", description: "Report a metric value for the current period", parametersSchema: { type: "object", properties: { metricId: { type: "string" }, value: { type: "number" }, periodDate: { type: "string" } }, required: ["metricId", "value", "periodDate"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { metricId, value, periodDate } = params as { metricId: string; value: number; periodDate: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("metric_values")} (id, metric_id, value, period_date, reported_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, metricId, value, periodDate, runCtx.agentId ?? null],
        );
        return { content: JSON.stringify({ reported: true, metricId, value, periodDate }) };
      },
    );

    // Governance approval timeout scanner job
    ctx.jobs.register("governance-approval-timeout-scanner", async (_job) => {
      // Query approvals directly via dbCtx (approvals is in coreReadTables)
      const circles = await dbCtx!.query<{ company_id: string; id: string }>(
        `SELECT DISTINCT company_id FROM ${tbl("circles")}`,
        [],
      );
      const companyIds = [...new Set(circles.map((c) => c.company_id))];

      for (const companyId of companyIds) {
        const pendingApprovals = await dbCtx!.query<{
          id: string;
          type: string;
          status: string;
          payload: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT id, type, status, payload, created_at FROM public.approvals WHERE company_id = $1 AND status = 'pending' AND type = 'request_board_approval'`,
          [companyId],
        );

        for (const approval of pendingApprovals) {
          const payload = (approval.payload as Record<string, unknown>) ?? {};
          if (payload["on_timeout"] !== "escalate_to_operator") continue;
          const timeoutHours = typeof payload["timeout_hours"] === "number" ? payload["timeout_hours"] : GOVERNANCE_APPROVAL_TIMEOUT_HOURS;
          const createdAt = new Date(approval.created_at).getTime();
          const expiresAt = createdAt + timeoutHours * 60 * 60 * 1000;
          if (Date.now() < expiresAt) continue;

          // Expired — mark as rejected via direct DB update
          await dbCtx!.execute(
            `UPDATE public.approvals SET status = 'rejected', decision_note = $2, decided_at = NOW() WHERE id = $1`,
            [approval.id, `auto:timed_out — governance proposal expired after ${timeoutHours}h with no decision. Operator review required.`],
          );

          // Log escalation activity
          await ctx.activity.log({
            companyId,
            message: `[GOVERNANCE TIMEOUT] Approval ${approval.id} expired after ${timeoutHours}h with no decision. Governance proposal: "${(payload["governance_proposal"] as Record<string, unknown>)?.["title"] ?? "unknown"}". Escalated to operator — manual review required.`,
            entityType: "approval",
            entityId: approval.id,
            metadata: {
              approvalId: approval.id,
              timeoutHours,
              expiresAt: new Date(expiresAt).toISOString(),
              governanceProposal: payload["governance_proposal"],
              patchStatus: "rejected_timed_out",
            },
          });
        }
      }

      // ── IDM phase deadline sweep ────────────────────────────────────────
      // Advance any non-terminal IDM rows whose phase deadline has elapsed.
      try {
        const stale = await dbCtx!.query<{ id: string; company_id: string; circle_id: string; phase: string }>(
          `SELECT id, company_id, circle_id, phase FROM ${tbl("idm_approvals")}
           WHERE phase NOT IN ('adopted', 'dropped') AND phase_deadline_at < NOW()`,
          [],
        );
        for (const row of stale) {
          const prevPhase = row.phase;
          const advanced = await idmAdvance(row.id);
          if (advanced && advanced.phase !== prevPhase) {
            await ctx.activity.log({
              companyId: row.company_id,
              message: `[IDM PHASE ADVANCE] ${row.id} ${prevPhase} -> ${advanced.phase} (deadline elapsed)`,
              entityType: "idm",
              entityId: row.id,
              metadata: { idmId: row.id, fromPhase: prevPhase, toPhase: advanced.phase, circleId: row.circle_id },
            });
          }
        }
      } catch (err) {
        console.warn("[holacracy] idm sweep error:", err instanceof Error ? err.message : String(err));
      }
    });

    // -----------------------------------------------------------------------
    // Accountability Scanner — MYA-78
    // Runs daily at 03:00. For each agent, evaluates due accountabilities and
    // raises operational tensions on breach.
    // Idempotency key: [SCAN:{agent_id}:{acc_name}:{scan_date}] in title.
    // -----------------------------------------------------------------------
    ctx.jobs.register("accountability-scanner", async (_job) => {
      // All data access via dbCtx — no HTTP calls needed (no http.outbound capability required).

      const cadenceIsDue = (cadence: string, now: Date): boolean => {
        if (cadence === "daily" || cadence === "hourly") return true;
        if (cadence === "weekly") return now.getDay() === 1; // Monday
        if (cadence === "monthly") return now.getDate() === 1;
        return false;
      };

      type EvalResult = { value: number | boolean | null; breached: boolean };
      const evaluateAccountability = async (
        agentId: string,
        companyId: string,
        acc: Record<string, unknown>,
      ): Promise<EvalResult> => {
        const name = String(acc.name ?? "");
        const threshold = acc.alert_threshold;
        const alertDirection = String(acc.alert_direction ?? "");

        // Helper: determine breach based on direction
        const checkBreach = (value: number, thresh: number, direction: string): boolean => {
          if (direction === "higher_is_better") return value < thresh;
          if (direction === "lower_is_better") return value > thresh;
          // Fallback: infer from metric name
          if (name.includes("latency") || name.includes("turnaround") || name.includes("backlog")) return value > thresh;
          return value < thresh; // Default: higher is better (completed/deployed/resolved)
        };

        if (name === "agent_active") {
          const rows = await dbCtx!.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND (status = 'in_progress' OR (status = 'done' AND completed_at >= date_trunc('month', NOW())))`,
            [companyId, agentId],
          );
          const active = (rows[0]?.count ?? 0) > 0;
          return { value: active, breached: !active };
        }
        if (name === "pr_review_latency_hours" || name.includes("latency_hours") || name.includes("turnaround_hours")) {
          const rows = await dbCtx!.query<{ avg_hours: number | null }>(
            `SELECT EXTRACT(EPOCH FROM AVG(NOW() - updated_at))/3600 as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_progress' AND updated_at < NOW() - INTERVAL '24 hours'`,
            [companyId, agentId],
          );
          const avg = rows[0]?.avg_hours ?? 0;
          const roundedAvg = Math.round(avg * 10) / 10;
          const directionForLatency = alertDirection || "lower_is_better";
          return { value: roundedAvg, breached: checkBreach(roundedAvg, Number(threshold), directionForLatency) };
        }
        if (name === "unrouted_backlog_count") {
          const rows = await dbCtx!.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id IS NULL AND status = 'backlog' AND created_at < NOW() - INTERVAL '24 hours'`,
            [companyId],
          );
          const count = rows[0]?.count ?? 0;
          const directionForBacklog = alertDirection || "lower_is_better";
          return { value: count, breached: checkBreach(count, Number(threshold), directionForBacklog) };
        }
        if (name === "engineering_issues_completed_weekly" || name.includes("completed") || name.includes("published") || name.includes("groomed") || name.includes("deployed") || name.includes("resolved")) {
          const rows = await dbCtx!.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= NOW() - INTERVAL '7 days'`,
            [companyId, agentId],
          );
          const count = rows[0]?.count ?? 0;
          const directionForCompleted = alertDirection || "higher_is_better";
          return { value: count, breached: checkBreach(count, Number(threshold ?? 0), directionForCompleted) };
        }
        // Unknown metric — skip
        return { value: null, breached: false };
      };

      // --------------- main scan loop ---------------
      const companyRows = await dbCtx!.query<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM ${tbl("circles")}`,
        [],
      );

      let raised = 0;
      let skipped = 0;
      const now = new Date();
      const scanDate = now.toISOString().split("T")[0];

      for (const { company_id: companyId } of companyRows) {
        // Load agents with accountabilities directly from DB
        const agents = await dbCtx!.query<{
          id: string;
          name: string;
          accountabilities: Array<Record<string, unknown>>;
        }>(
          `SELECT id, name, accountabilities FROM public.agents WHERE company_id = $1 AND status != 'deleted'`,
          [companyId],
        );

        // Find GCC (root circle) as fallback
        const gccRows = await dbCtx!.query<{ id: string }>(
          `SELECT id FROM ${tbl("circles")} WHERE company_id = $1 AND parent_circle_id IS NULL LIMIT 1`,
          [companyId],
        );
        const fallbackCircleId = gccRows[0]?.id;
        if (!fallbackCircleId) continue;

        for (const agent of agents) {
          const agentId = agent.id;
          const agentName = agent.name ?? agentId;
          const accountabilities = Array.isArray(agent.accountabilities) ? agent.accountabilities : [];
          if (accountabilities.length === 0) continue;

          // Determine primary circle from role assignments
          const roleRows = await dbCtx!.query<{ circle_id: string }>(
            `SELECT r.circle_id FROM ${tbl("role_assignments")} ra JOIN ${tbl("roles")} r ON r.id = ra.role_id WHERE ra.agent_id = $1 LIMIT 1`,
            [agentId],
          );
          const circleId = roleRows[0]?.circle_id ?? fallbackCircleId;

          for (const acc of accountabilities) {
            const cadence = String(acc.cadence ?? "daily");
            if (!cadenceIsDue(cadence, now)) continue;

            const accName = String(acc.name ?? "unknown");
            const idempotencyKey = `scan:${agentId}:${accName}:${scanDate}`;

            // Idempotency: skip if tension already filed today
            const existing = await dbCtx!.query<{ id: string }>(
              `SELECT id FROM ${tbl("tensions")} WHERE idempotency_key = $1 LIMIT 1`,
              [idempotencyKey],
            );
            if (existing.length > 0) { skipped++; continue; }

            const { value, breached } = await evaluateAccountability(agentId, companyId, acc);
            if (!breached) continue;

            const threshold = acc.alert_threshold;
            const tensionId = randomUUID();
            const title = `[Scanner] ${agentName} breached ${accName}: ${value} vs threshold ${threshold}`;
            const description = JSON.stringify({
              agent_id: agentId,
              agent_name: agentName,
              accountability_name: accName,
              metric_value: value,
              threshold,
              cadence,
              observed_at: now.toISOString(),
              scan_date: scanDate,
              escalation_path: acc.escalation_path ?? [],
            });

            await dbCtx!.execute(
              `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type, idempotency_key) VALUES ($1, $2, $3, $4, $5, 'operational', $6)`,
              [tensionId, circleId, agentId, title, description, idempotencyKey],
            );

            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
              [companyId, agentId, circleId, JSON.stringify({ tensionId, source: "accountability-scanner", accountability: accName, scanDate })],
            );

            raised++;
            await ctx.activity.log({
              companyId,
              message: `[ACCOUNTABILITY BREACH] ${agentName} / ${accName}: ${value} vs threshold ${threshold}. Tension ${tensionId} raised.`,
              entityType: "agent",
              entityId: agentId,
              metadata: { tensionId, agentId, accName, value, threshold, circleId, scanDate },
            });
          }
        }
      }

      await ctx.activity.log({
        companyId: companyRows[0]?.company_id ?? "unknown",
        message: `[ACCOUNTABILITY SCAN] ${scanDate} complete. Tensions raised: ${raised}, skipped (dedup): ${skipped}.`,
        entityType: "system",
        entityId: "accountability-scanner",
        metadata: { raised, skipped, scanDate },
      });
    });

    // ── Phase 1.15h-g1 — Steward / Concierge auto-healer ─────────────────
    // Runs every 5 minutes; scans for 5 runtime pathologies and either heals
    // idempotently or escalates via tension to GCC Lead Link. See the
    // `runStewardHealer` function near the top of this file for details.
    ctx.jobs.register("steward-healer", async (_job) => {
      try {
        const result = await runStewardHealer();
        console.log("[holacracy] steward-healer", result);
      } catch (err) {
        console.error(
          "[holacracy] steward-healer failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });

    // ── Phase 1.8 — Tactical Pulse routine ───────────────────────────────
    // Promotes the existing API-only `runTacticalPulse` into a scheduled
    // routine. Iterates every circle in every active company and snapshots
    // the tactical state. Per-circle cadence is hardcoded for now; a future
    // pulses-config table can make this configurable.
    ctx.jobs.register("tactical-pulse", async (_job) => {
      const circleRows = await dbCtx!.query<{ id: string; company_id: string; name: string }>(
        `SELECT id, company_id, name FROM ${tbl("circles")}`,
        [],
      );
      let pulses = 0;
      let failures = 0;
      for (const circle of circleRows) {
        try {
          await runTacticalPulse(circle.company_id, circle.id, "scheduled");
          pulses += 1;
        } catch (err) {
          failures += 1;
          console.warn(
            "[holacracy] tactical-pulse failed for circle",
            circle.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      // Surface a single aggregated activity log for observability.
      const someCompanyId = circleRows[0]?.company_id;
      if (someCompanyId) {
        await ctx.activity.log({
          companyId: someCompanyId,
          message: `[TACTICAL PULSE] pulses=${pulses} failures=${failures}`,
          entityType: "system",
          entityId: "tactical-pulse",
          metadata: { pulses, failures, circles: circleRows.length },
        });
      }
    });

    // ── Phase 1.8 — Governance Pulse routine (Phase 3 stub) ───────────────
    // Registered now so the scheduler knows the cadence; Phase 3 fills in
    // the reflection logic that turns recurring tensions into proposals.
    ctx.jobs.register("governance-pulse", async (_job) => {
      console.info("[holacracy] governance-pulse stub invoked — Phase 3 will implement.");
    });

    // ── Phase 1.14 — Circle Discussions scheduler ─────────────────────────
    // Sweep open discussions every minute. The scheduler is idempotent:
    // every spawn-issue path checks `NOT EXISTS` first, every phase
    // transition uses `WHERE phase = $old` so concurrent ticks can't
    // double-fire.
    ctx.jobs.register("advance-circle-discussions", async (_job) => {
      try {
        const result = await advanceCircleDiscussions();
        if (result.advanced > 0 || result.concluded > 0) {
          console.info(
            `[holacracy] discussions tick: checked=${result.checked} advanced=${result.advanced} concluded=${result.concluded}`,
          );
        }
      } catch (err) {
        console.warn(
          "[holacracy] advance-circle-discussions failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });

    // ── Phase 1.14 — Circle Discussions data source ───────────────────────
    // Returns { open: CircleDiscussionRow[], concluded: CircleDiscussionRow[],
    //           turns: Record<discussionId, DiscussionTurnSummary[]> } for the
    // DiscussionsTab. Caller passes { circleId } (the project entity id;
    // resolveCircleId handles project → circle mapping).
    ctx.data.register("circle-discussions", async (params) => {
      const circleIdRaw = (params.circleId as string | undefined) ?? "";
      const circleId = await resolveCircleId(circleIdRaw);
      if (!circleId) return { open: [], concluded: [], turns: {} };
      const open = await ctx.db.query<CircleDiscussionRow>(
        `SELECT * FROM public.circle_discussions
          WHERE circle_id = $1 AND status = 'open'
          ORDER BY started_at DESC`,
        [circleId],
      );
      const concluded = await ctx.db.query<CircleDiscussionRow>(
        `SELECT * FROM public.circle_discussions
          WHERE circle_id = $1 AND status = 'concluded'
          ORDER BY concluded_at DESC NULLS LAST
          LIMIT 20`,
        [circleId],
      );
      const turnsMap: Record<string, DiscussionTurnSummary[]> = {};
      for (const d of [...open, ...concluded]) {
        try {
          turnsMap[d.id] = await loadDiscussionTurns(d.id);
        } catch {
          turnsMap[d.id] = [];
        }
      }
      return { open, concluded, turns: turnsMap };
    });

    // Phase 1.15h-c — unified Messages feed at the circle level.
    // Returns a discriminated stream of:
    //   - turn        — discussion turn issue + its content
    //   - lifecycle   — discussion-opened / -concluded markers derived from circle_discussions
    //   - commitment  — discussion_commitments rows
    //   - comment     — issue_comments on any issue belonging to a project in this circle
    // Caller sorts by `at` DESC and applies any kind filter client-side.
    ctx.data.register("circle-messages", async (params) => {
      const circleIdRaw = (params.circleId as string | undefined) ?? "";
      const circleId = await resolveCircleId(circleIdRaw);
      const limit = Math.min(Number(params.limit ?? 100), 200);
      if (!circleId) return { items: [], circleId: null };

      type FeedItem =
        | { kind: "turn"; id: string; at: string; discussionId: string; agentId: string | null; agentName: string | null; roundNumber: number; isSummary: boolean; status: string; content: string | null; topic: string | null }
        | { kind: "lifecycle"; id: string; at: string; discussionId: string; event: "opened" | "concluded"; topic: string; conclusion: string | null; conclusionKind: string | null; idmApprovalId: string | null }
        | { kind: "commitment"; id: string; at: string; discussionId: string; agentId: string; agentName: string | null; signal: string; reason: string | null }
        | { kind: "comment"; id: string; at: string; issueId: string; issueTitle: string | null; authorAgentId: string | null; authorAgentName: string | null; authorUserId: string | null; body: string };

      const items: FeedItem[] = [];

      // Look up the project_id this circle represents (for the comments query).
      const circleProjectRows = await ctx.db.query<{ project_id: string | null }>(
        `SELECT project_id::text AS project_id FROM ${tbl("circles")} WHERE id = $1 LIMIT 1`,
        [circleId],
      );
      const circleProjectId = circleProjectRows[0]?.project_id ?? null;

      // Discussions in this circle, plus their turns/commitments/lifecycle.
      const discLimit = Math.max(20, Math.floor(limit / 4));
      const discussions = await ctx.db.query<CircleDiscussionRow & { topic: string }>(
        `SELECT * FROM public.circle_discussions
          WHERE circle_id = $1
          ORDER BY started_at DESC
          LIMIT ${discLimit}`,
        [circleId],
      );

      for (const d of discussions) {
        items.push({
          kind: "lifecycle",
          id: `lc-open-${d.id}`,
          at: (d as unknown as { started_at: string }).started_at,
          discussionId: d.id,
          event: "opened",
          topic: d.topic,
          conclusion: null,
          conclusionKind: null,
          idmApprovalId: null,
        });
        if (d.status === "concluded" || d.phase === "concluded") {
          const concludedAt = (d as unknown as { concluded_at: string | null }).concluded_at;
          items.push({
            kind: "lifecycle",
            id: `lc-concl-${d.id}`,
            at: concludedAt ?? (d as unknown as { started_at: string }).started_at,
            discussionId: d.id,
            event: "concluded",
            topic: d.topic,
            conclusion: (d as unknown as { conclusion: string | null }).conclusion ?? null,
            conclusionKind: (d as unknown as { conclusion_kind: string | null }).conclusion_kind ?? null,
            idmApprovalId: (d as unknown as { idm_approval_id: string | null }).idm_approval_id ?? null,
          });
        }
        try {
          const turns = await loadDiscussionTurns(d.id);
          for (const t of turns) {
            items.push({
              kind: "turn",
              id: `turn-${t.issueId}`,
              at: t.completedAt ?? t.createdAt,
              discussionId: d.id,
              agentId: t.agentId,
              agentName: t.agentName,
              roundNumber: t.roundNumber,
              isSummary: t.isSummary,
              status: t.status,
              content: t.content,
              topic: d.topic,
            });
          }
        } catch {
          /* skip */
        }
      }

      // Commitments for those discussions. Build the IN-list inline — discussion
      // IDs are UUIDs we just SELECT'd, so quoting them as SQL literals is safe
      // (and avoids driver-specific issues with array-typed parameters).
      if (discussions.length > 0) {
        const discIdsSql = discussions
          .map((d) => `'${d.id.replace(/'/g, "''")}'::uuid`)
          .join(", ");
        const commitments = await ctx.db.query<{
          discussion_id: string;
          agent_id: string;
          agent_name: string | null;
          signal: string;
          reason: string | null;
          signaled_at: string;
        }>(
          `SELECT dc.discussion_id, dc.agent_id::text AS agent_id, a.name AS agent_name,
                  dc.signal, dc.reason, dc.signaled_at::text AS signaled_at
             FROM public.discussion_commitments dc
             LEFT JOIN public.agents a ON a.id = dc.agent_id
            WHERE dc.discussion_id IN (${discIdsSql})
            ORDER BY dc.signaled_at DESC
            LIMIT ${limit}`,
          [],
        );
        for (const c of commitments) {
          items.push({
            kind: "commitment",
            id: `cmt-${c.discussion_id}-${c.agent_id}`,
            at: c.signaled_at,
            discussionId: c.discussion_id,
            agentId: c.agent_id,
            agentName: c.agent_name,
            signal: c.signal,
            reason: c.reason,
          });
        }
      }

      // Issue comments on any issue belonging to a project in this circle.
      // Excludes discussion-turn comments (those are already surfaced as "turn").
      const comments = circleProjectId
        ? await ctx.db.query<{
            id: string;
            issue_id: string;
            issue_title: string | null;
            author_agent_id: string | null;
            author_agent_name: string | null;
            author_user_id: string | null;
            body: string;
            created_at: string;
          }>(
            `SELECT ic.id::text AS id,
                    ic.issue_id::text AS issue_id,
                    i.title AS issue_title,
                    ic.author_agent_id::text AS author_agent_id,
                    a.name AS author_agent_name,
                    ic.author_user_id,
                    ic.body,
                    ic.created_at::text AS created_at
               FROM public.issue_comments ic
               JOIN public.issues i ON i.id = ic.issue_id
               LEFT JOIN public.agents a ON a.id = ic.author_agent_id
              WHERE i.project_id = $1
                AND COALESCE(i.origin_kind, '') NOT IN ('discussion:turn', 'discussion:summary')
              ORDER BY ic.created_at DESC
              LIMIT ${limit}`,
            [circleProjectId],
          )
        : [];
      for (const c of comments) {
        items.push({
          kind: "comment",
          id: `com-${c.id}`,
          at: c.created_at,
          issueId: c.issue_id,
          issueTitle: c.issue_title,
          authorAgentId: c.author_agent_id,
          authorAgentName: c.author_agent_name,
          authorUserId: c.author_user_id,
          body: c.body,
        });
      }

      items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
      return { items: items.slice(0, limit), circleId };
    });

    ctx.actions.register("discussion.create", async (params) => {
      const result = await createDiscussion({
        circleId: (params.circleId as string) ?? null,
        topic: (params.topic as string) ?? "",
        prompt: params.prompt as string | undefined,
        rounds: params.rounds as number | undefined,
        speakerMode: params.speakerMode as string | undefined,
        companyId: (params.companyId as string) ?? "",
        initiatedByAgentId: (params.initiatedByAgentId as string | null | undefined) ?? null,
        initiatedByUserId: (params.initiatedByUserId as string | null | undefined) ?? null,
        // Phase 1.15h-h1 — SMART forwarding from UI / scripts.
        successCriterion: params.successCriterion as string | undefined,
        scopeIn: params.scopeIn as string[] | undefined,
        scopeOut: params.scopeOut as string[] | undefined,
        decisionDeadline: params.decisionDeadline as string | Date | undefined,
        motivatingTensionId: params.motivatingTensionId as string | undefined,
        expectedOutputKind: params.expectedOutputKind as string | undefined,
        // Phase 1.15h-i #2 — Grove pre-flight forwarding.
        decisionOwnerAgentId:
          (params.decisionOwnerAgentId as string | null | undefined) ?? null,
        consultedAgentIds: params.consultedAgentIds as string[] | undefined,
        ratifierAgentId:
          (params.ratifierAgentId as string | null | undefined) ?? null,
        informedAgentIds: params.informedAgentIds as string[] | undefined,
      });
      if (!result.ok) throw new Error(result.error);
      return { discussionId: result.discussion.id, issueIds: result.issueIds };
    });

    ctx.actions.register("discussion.conclude", async (params) => {
      const id = params.discussionId as string;
      const conclusion = (params.conclusion as string) ?? "(manually concluded)";
      const conclusionKind = (params.conclusionKind as string | null | undefined) ?? "note";
      const result = await concludeDiscussion(id, conclusion, conclusionKind);
      if (!result.ok) throw new Error(result.error);
      return { discussionId: id };
    });


    // ── Phase 1.8 — `system-pulse` data source for SystemPulseTab ─────────
    // Returns the most recent host heartbeat snapshot reconstructed from DB
    // aggregates. The retained MQTT topic is the live channel; this is the
    // fallback for environments where the UI cannot subscribe to MQTT.
    ctx.data.register("system-pulse", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (!companyId) return null;
      try {
        const tactical = await ctx.db.query<{
          circle_id: string;
          recorded_at: string;
        }>(
          `SELECT circle_id, MAX(recorded_at) AS recorded_at
             FROM ${tbl("tactical_records")}
             WHERE company_id = $1
             GROUP BY circle_id`,
          [companyId],
        );
        const lastTacticalPulseByCircle: Record<string, string> = {};
        for (const r of tactical) {
          lastTacticalPulseByCircle[r.circle_id] = new Date(r.recorded_at).toISOString();
        }
        return {
          tickId: -1,
          timestamp: new Date().toISOString(),
          dbHealthy: true,
          brokerHealthy: true,
          activeAgentCount: 0,
          openEscalations: 0,
          silentRunsDetected: 0,
          recoveredRuns: 0,
          degradedMode: "green" as const,
          lastIdmPhaseAdvance: null,
          lastTacticalPulseByCircle,
          lastGovernancePulseByCircle: {},
        };
      } catch {
        return null;
      }
    });

    // ── Phase 1.9 — `company-dna` data source for DNATab ──────────────────
    // Returns a best-effort envelope projected from the holacracy + companies
    // tables. The retained MQTT topic remains the canonical channel.
    ctx.data.register("company-dna", async (params) => {
      const companyId = params.companyId as string | undefined;
      if (!companyId) return null;
      try {
        const companyRows = await ctx.db.query<{
          id: string;
          name: string;
          mission_statement: string | null;
          values: string[] | null;
          constitution: string | null;
          dna_generation: number;
          dna_mutated_at: string | null;
          dna_mutated_reason: string | null;
        }>(
          `SELECT id, name, mission_statement, values, constitution,
                  dna_generation, dna_mutated_at, dna_mutated_reason
             FROM public.companies WHERE id = $1 LIMIT 1`,
          [companyId],
        );
        const company = companyRows[0];
        if (!company) return null;
        const policies = await ctx.db.query<{ id: string; title: string; description: string | null }>(
          `SELECT p.id, p.title, p.description
             FROM ${tbl("policies")} p
             JOIN ${tbl("circles")} c ON c.id = p.circle_id
             WHERE c.company_id = $1 AND c.parent_circle_id IS NULL`,
          [companyId],
        ).catch(() => []);
        const agreements = await ctx.db.query<{
          id: string; condition: string | null; commitment: string | null;
        }>(
          `SELECT id, condition, commitment FROM ${tbl("agreements")}
             WHERE company_id = $1 AND status = 'active'`,
          [companyId],
        ).catch(() => []);
        const anchor = await ctx.db.query<{ id: string }>(
          `SELECT id FROM ${tbl("circles")} WHERE company_id = $1 AND parent_circle_id IS NULL LIMIT 1`,
          [companyId],
        ).catch(() => []);
        return {
          dna_version: "1" as const,
          company_id: company.id,
          generation: company.dna_generation,
          mutated_at: company.dna_mutated_at,
          mutated_reason: company.dna_mutated_reason,
          identity: {
            name: company.name,
            mission_statement: company.mission_statement,
            values: Array.isArray(company.values) ? company.values : [],
          },
          constitution: {
            governance: "holacracy-v5",
            transport: "a2a-mqtt",
            text: company.constitution,
            doctrine_ref: "docs/specs/holacracy-vs-hierarchy-ai-agents.md",
          },
          policies: policies.map((p) => ({ id: p.id, title: p.title, scope: "company", text: p.description })),
          active_agreements: agreements,
          heuristic_weights_version: null,
          anchor_circle_id: anchor[0]?.id ?? null,
        };
      } catch {
        return null;
      }
    });

    ctx.tools.register(
      TOOL_NAMES.onboardAgent,
      { displayName: "Onboard Agent", description: "Create a custom role in a circle and prepare onboarding. Circle Lead only.", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, agentName: { type: "string" }, roleName: { type: "string" }, rolePurpose: { type: "string" }, roleAccountabilities: { type: "array", items: { type: "string" } }, roleDomains: { type: "array", items: { type: "string" } } }, required: ["circleId", "agentName", "roleName", "rolePurpose"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, agentName, roleName, rolePurpose, roleAccountabilities, roleDomains } = params as {
          circleId: string; agentName: string; roleName: string; rolePurpose: string;
          roleAccountabilities?: string[]; roleDomains?: string[];
        };
        const circles = await dbCtx!.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        if (circles.length === 0) return { content: "Circle not found", error: "not found" };
        const circle = circles[0];
        const roleId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, 'custom', $5, $6)`,
          [roleId, circleId, roleName, rolePurpose, JSON.stringify(roleAccountabilities ?? []), JSON.stringify(roleDomains ?? [])],
        );
        const strategies = await dbCtx!.query(`SELECT s.text, a.name as set_by_name FROM ${tbl("strategies")} s LEFT JOIN public.agents a ON a.id = s.set_by WHERE s.circle_id = $1 AND s.active = true`, [circleId]);
        const policies = await dbCtx!.query(`SELECT title, domain, description FROM ${tbl("policies")} WHERE circle_id = $1`, [circleId]);
        const roles = await dbCtx!.query(`SELECT r.name, r.purpose, r.role_type, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`, [circleId]);
        const teamList = roles.map((r: any) => `- ${r.agent_name ?? "(vacant)"}: ${r.name} -- ${r.purpose ?? ""}`).join("\n");
        const strategyText = strategies.length > 0 ? (strategies[0] as any).text : "No strategy set";
        const policyList = policies.map((p: any) => `- ${p.title}${p.domain ? ` (${p.domain})` : ""}: ${p.description}`).join("\n");
        const holacracyRoleMd = `# Holacracy Role: ${roleName}
## Circle: ${circle.name}
**Circle Purpose:** ${circle.purpose ?? ""}

## Your Role
**Role Purpose:** ${rolePurpose}
You fill the ${roleName} role in the ${circle.name} circle.

## Accountabilities
${(roleAccountabilities ?? []).map(a => `- ${a}`).join("\n") || "- (none defined yet)"}

## Authority & Constraints
- You MAY act autonomously within your role's accountabilities
- You CANNOT modify governance -- raise governance tensions instead
- You CANNOT act on domains owned by other roles without permission

## AI Agent Protocol
- Act only within your role's scope. Escalate anything outside it.
- Every action is logged. Act transparently.
- Your role can be modified through governance. You do not modify your own role.
- Use holacracy-get-circle and holacracy-get-role tools to understand org context before acting.
- Principle: "Prompts reference the org map. The org map does not reference prompts."

## Tensions
A tension = gap between current reality and potential you see for your role.
- Operational: things you need to get work done. Raise via holacracy-raise-tension with type "operational".
- Governance: structural issues about roles/accountabilities/policies. Raise with type "governance".

## Two-Tier Authority
- **Operational decisions** within your role scope: act autonomously, no approval needed.
- **Structural changes** (modifying roles, domains, policies): raise as governance tension for human review.

## Your Circle Team
${teamList}

## Active Strategy
"${strategyText}"
All operational decisions should align with this strategy.

## Relevant Policies
${policyList || "No policies defined yet."}

## Error Protocol
1. Log the action via holacracy-log-action with actionType "escalation"
2. If the error was within your role scope: fix it and document what happened
3. If the error was structural (your role definition was inadequate): raise a governance tension
4. The audit trail is your protection -- transparent logging demonstrates good faith`;

        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'agent-onboarded', $4)`,
          [circle.company_id, runCtx.agentId ?? null, circleId, JSON.stringify({ roleId, roleName, agentName, rolePurpose })],
        );
        return { content: JSON.stringify({
          roleId,
          roleName,
          circleId,
          circleName: circle.name,
          agentName,
          holacracyRoleMd,
          nextSteps: [
            `1. Create agent "${agentName}" using paperclip-create-agent skill`,
            `2. Assign agent to role: PATCH /api/plugins/paperclipai.plugin-holacracy/api/circles/${circleId}/roles/${roleId}/assign with {"companyId":"${circle.company_id}","agentId":"<new-agent-id>"}`,
            `3. Push holacracy-role.md: PUT /api/agents/<new-agent-id>/instructions-bundle/file with {"path":"holacracy-role.md","content":"<the holacracyRoleMd above>"}`,
          ],
        }, null, 2) };
      },
    );

    // ── Agreements (afspraken) — Holacracy's 3rd governance output ──────────
    // Distinct from policies (rules) and elections (assignments). Captures
    // explicit "If Y then X" commitments between roles. Status: proposed -> active -> (expired|revoked).

    ctx.data.register("circle-agreements", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      return await listAgreementsForCircle(circleId);
    });

    ctx.tools.register(
      TOOL_NAMES.listAgreements,
      { displayName: "List Agreements", description: "List agreements (afspraken) for a circle — intra-circle plus cross-circle agreements where the circle holds a party role", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId } = params as { circleId: string };
        const rows = await listAgreementsForCircle(circleId);
        return { content: JSON.stringify({ agreements: rows, count: rows.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.proposeAgreement,
      { displayName: "Propose Agreement", description: "Propose a new agreement between roles in 'If Y then X' form. Status starts as 'proposed'.", parametersSchema: { type: "object", properties: { scope: { type: "string", enum: ["intra_circle", "cross_circle"] }, primaryCircleId: { type: "string" }, parties: { type: "array", items: { type: "object", properties: { roleId: { type: "string" }, circleId: { type: "string" } }, required: ["roleId", "circleId"] } }, title: { type: "string" }, condition: { type: "string" }, commitment: { type: "string" }, expiresAt: { type: "string" }, proposedViaTensionId: { type: "string" } }, required: ["scope", "primaryCircleId", "parties", "title", "commitment"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const parsed = parseCreateAgreementInput(params);
        if (!parsed.ok) return { content: parsed.error, error: parsed.error };
        const created = await createAgreement({ companyId: runCtx.companyId, ...parsed.value });
        return { content: JSON.stringify(created, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.activateAgreement,
      { displayName: "Activate Agreement", description: "Move an agreement from 'proposed' to 'active'. Stamps activated_at.", parametersSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      async (params): Promise<ToolResult> => {
        const { id } = params as { id: string };
        const updated = await activateAgreement(id);
        if (!updated) return { content: "Agreement not found", error: "not found" };
        return { content: JSON.stringify(updated, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.revokeAgreement,
      { displayName: "Revoke Agreement", description: "Revoke an agreement with a reason for the audit trail.", parametersSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] } },
      async (params): Promise<ToolResult> => {
        const { id, reason } = params as { id: string; reason: string };
        if (!reason || !reason.trim()) return { content: "reason is required", error: "validation" };
        const updated = await revokeAgreement(id, reason);
        if (!updated) return { content: "Agreement not found", error: "not found" };
        return { content: JSON.stringify(updated, null, 2) };
      },
    );

    // ── IDM (Integrative Decision-Making) ──────────────────────────────────
    // Holacracy's canonical 6-phase async governance protocol, ridden on top
    // of the existing approvals pipeline.

    ctx.data.register("idm-detail", async (params) => {
      const idmId = params.idmId as string;
      if (!idmId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idmId)) return null;
      const idm = await loadIdm(idmId);
      if (!idm) return null;
      const inputs = await loadIdmInputs(idmId);
      const objections = await loadIdmObjections(idmId);
      return { idm, inputs, objections };
    });

    ctx.data.register("idm-list-by-circle", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      return await dbCtx!.query<IdmApprovalRow>(
        `SELECT * FROM ${tbl("idm_approvals")} WHERE circle_id = $1 ORDER BY created_at DESC`,
        [circleId],
      );
    });

    ctx.tools.register(
      TOOL_NAMES.idmPropose,
      { displayName: "IDM: Propose", description: "Open an IDM process. Creates the companion approval and starts phase=proposal with a 24h deadline.", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, tensionId: { type: "string" }, proposal: { type: "object", properties: { kind: { type: "string" }, content: {} }, required: ["kind", "content"] } }, required: ["circleId", "proposal"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const parsed = parseZodInput<IdmProposeInput>(idmProposeSchema, params, "idm propose");
        if (!parsed.ok) return { content: parsed.error, error: parsed.error };
        const result = await idmPropose({
          companyId: runCtx.companyId,
          ...parsed.value,
          proposerAgentId: parsed.value.proposerAgentId ?? runCtx.agentId ?? undefined,
        });
        return { content: JSON.stringify(result, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.idmQuestion,
      { displayName: "IDM: Clarifying Question", description: "Post a clarifying question during the 'clarifying' phase.", parametersSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, roleId: { type: "string" } }, required: ["id", "body"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { id, body, roleId } = params as { id: string; body: string; roleId?: string };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await idmAddInput({ idmId: id, kind: "question", agentId: runCtx.agentId, roleId, payload: { body } });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.idmReact,
      { displayName: "IDM: Reaction", description: "Post a reaction during the 'reactions' phase.", parametersSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, roleId: { type: "string" } }, required: ["id", "body"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { id, body, roleId } = params as { id: string; body: string; roleId?: string };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await idmAddInput({ idmId: id, kind: "reaction", agentId: runCtx.agentId, roleId, payload: { body } });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.idmAmend,
      { displayName: "IDM: Amendment", description: "Propose an amendment or clarification during the 'amend_or_clarify' phase.", parametersSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, roleId: { type: "string" } }, required: ["id", "body"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { id, body, roleId } = params as { id: string; body: string; roleId?: string };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await idmAddInput({ idmId: id, kind: "amendment", agentId: runCtx.agentId, roleId, payload: { body } });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.idmObject,
      { displayName: "IDM: Raise Objection", description: "Raise an objection during the 'objections' phase. Validity tests are filled separately.", parametersSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, roleId: { type: "string" } }, required: ["id", "body"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { id, body, roleId } = params as { id: string; body: string; roleId?: string };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await idmObject({ idmId: id, raisedByAgentId: runCtx.agentId, raisedByRoleId: roleId, body });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.idmValidateObjection,
      { displayName: "IDM: Validate Objection", description: "Run the three-test validity check on an objection.", parametersSchema: { type: "object", properties: { objectionId: { type: "string" }, tests: { type: "object" } }, required: ["objectionId", "tests"] } },
      async (params): Promise<ToolResult> => {
        const { objectionId, tests } = params as { objectionId: string; tests: unknown };
        const parsed = parseZodInput(idmValidateObjectionSchema, { tests }, "idm validate objection");
        if (!parsed.ok) return { content: parsed.error, error: parsed.error };
        const updated = await idmValidateObjection(objectionId, parsed.value.tests);
        if (!updated) return { content: "Objection not found", error: "not found" };
        return { content: JSON.stringify(updated, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.idmIntegrate,
      { displayName: "IDM: Integrate Objection", description: "Record an amendment that addresses a validated objection.", parametersSchema: { type: "object", properties: { id: { type: "string" }, objectionId: { type: "string" }, amendment: { type: "object" } }, required: ["id", "objectionId", "amendment"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { id } = params as { id: string };
        const parsed = parseZodInput<IdmIntegrateInput>(idmIntegrateSchema, params, "idm integrate");
        if (!parsed.ok) return { content: parsed.error, error: parsed.error };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await idmIntegrate({
          idmId: id,
          objectionId: parsed.value.objectionId,
          amendment: parsed.value.amendment,
          agentId: runCtx.agentId,
          roleId: parsed.value.roleId,
        });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result, null, 2) };
      },
    );

    // ── Phase 2 — Cross-links (Concept 1) ─────────────────────────────
    ctx.data.register("circle-cross-links", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      return await listCrossLinksForCircle(circleId);
    });

    ctx.tools.register(
      TOOL_NAMES.createCrossLink,
      { displayName: "Create Cross-Link", description: "Create a sibling-circle cross-link.", parametersSchema: { type: "object", properties: { circleAId: { type: "string" }, circleBId: { type: "string" }, repRoleAId: { type: "string" }, repRoleBId: { type: "string" }, purpose: { type: "string" }, createdViaTensionId: { type: "string" } }, required: ["circleAId", "circleBId", "repRoleAId", "repRoleBId", "purpose"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const parsed = parseZodInput<CreateCrossLinkInput>(createCrossLinkSchema, params, "create cross-link");
        if (!parsed.ok) return { content: parsed.error, error: parsed.error };
        const result = await createCrossLink(runCtx.companyId, parsed.value);
        if (!result.ok) return { content: result.error, error: result.error };
        await publishCrossLinkEvent(result.row, "cross_link.created");
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listCrossLinks,
      { displayName: "List Cross-Links", description: "List cross-links touching a circle.", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId } = params as { circleId: string };
        const rows = await listCrossLinksForCircle(circleId);
        return { content: JSON.stringify({ crossLinks: rows, count: rows.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.dissolveCrossLink,
      { displayName: "Dissolve Cross-Link", description: "Dissolve an active cross-link with a reason.", parametersSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] } },
      async (params): Promise<ToolResult> => {
        const { id, reason } = params as { id: string; reason: string };
        if (!reason || !reason.trim()) return { content: "reason is required", error: "validation" };
        const updated = await dissolveCrossLink(id, reason);
        if (!updated) return { content: "Cross-link not found", error: "not found" };
        await publishCrossLinkEvent(updated, "cross_link.dissolved", { reason });
        return { content: JSON.stringify(updated, null, 2) };
      },
    );

    // ── Phase 2 — Role-release lifecycle (Concept 3) ──────────────────
    ctx.data.register("role-releases", async (params) => {
      const rawCircle = params.circleId as string | undefined;
      // If the caller passed a UUID, try to resolve project→circle; otherwise pass undefined so the helper lists company-wide.
      const circleId = rawCircle ? (await resolveCircleId(rawCircle)) ?? undefined : undefined;
      const status = params.status as string | undefined;
      return await listRoleReleases(circleId, status);
    });

    ctx.tools.register(
      TOOL_NAMES.releaseRole,
      { displayName: "Release Role", description: "Request release of a role assignment.", parametersSchema: { type: "object", properties: { roleAssignmentId: { type: "string" }, handoffToAgentId: { type: "string" }, handoffNotes: { type: "string" }, reason: { type: "string" } }, required: ["roleAssignmentId"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { roleAssignmentId, handoffToAgentId, handoffNotes, reason } = params as { roleAssignmentId: string; handoffToAgentId?: string; handoffNotes?: string; reason?: string };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await requestRoleRelease(runCtx.companyId, roleAssignmentId, {
          releasedByAgentId: runCtx.agentId,
          handoffToAgentId,
          handoffNotes,
          reason,
        });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.release, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.acceptRelease,
      { displayName: "Accept Role Release", description: "Lead Link accepts a role-release request.", parametersSchema: { type: "object", properties: { releaseId: { type: "string" } }, required: ["releaseId"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { releaseId } = params as { releaseId: string };
        if (!runCtx.agentId) return { content: "agentId required from caller", error: "validation" };
        const result = await acceptRoleRelease(runCtx.companyId, releaseId, runCtx.agentId);
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.release, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.completeHandoff,
      { displayName: "Complete Role Handoff", description: "Complete a pending_handoff release.", parametersSchema: { type: "object", properties: { releaseId: { type: "string" } }, required: ["releaseId"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { releaseId } = params as { releaseId: string };
        const result = await completeRoleRelease(runCtx.companyId, releaseId);
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.release, null, 2) };
      },
    );

    // ── Phase 2 — Tactical-pulse + cross-role requests (Concept 6) ────
    ctx.data.register("tactical-records", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      return await dbCtx!.query<TacticalRecordRow>(
        `SELECT * FROM ${tbl("tactical_records")} WHERE circle_id = $1 ORDER BY recorded_at DESC LIMIT 100`,
        [circleId],
      );
    });

    ctx.data.register("cross-role-requests", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      // JOIN requesting + target roles by name so the UI can render human names instead of raw UUIDs.
      return await dbCtx!.query<CrossRoleRequestRow>(
        `SELECT DISTINCT crr.*,
                req_r.name AS requesting_role_name,
                tgt_r.name AS target_role_name
           FROM ${tbl("cross_role_requests")} crr
           JOIN ${tbl("roles")} r ON r.id = crr.target_role_id OR r.id = crr.requesting_role_id
           LEFT JOIN ${tbl("roles")} req_r ON req_r.id = crr.requesting_role_id
           LEFT JOIN ${tbl("roles")} tgt_r ON tgt_r.id = crr.target_role_id
          WHERE r.circle_id = $1
          ORDER BY crr.created_at DESC LIMIT 100`,
        [circleId],
      );
    });

    ctx.tools.register(
      TOOL_NAMES.runTacticalPulse,
      { displayName: "Run Tactical Pulse", description: "Snapshot circle tactical state and broadcast.", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, cadence: { type: "string" } }, required: ["circleId"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, cadence } = params as { circleId: string; cadence?: string };
        const pulse = await runTacticalPulse(runCtx.companyId, circleId, cadence ?? "ad_hoc");
        return { content: JSON.stringify(pulse.record, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.listTacticalRecords,
      { displayName: "List Tactical Records", description: "List tactical pulse records for a circle.", parametersSchema: { type: "object", properties: { circleId: { type: "string" } }, required: ["circleId"] } },
      async (params): Promise<ToolResult> => {
        const { circleId } = params as { circleId: string };
        const rows = await dbCtx!.query<TacticalRecordRow>(
          `SELECT * FROM ${tbl("tactical_records")} WHERE circle_id = $1 ORDER BY recorded_at DESC LIMIT 100`,
          [circleId],
        );
        return { content: JSON.stringify({ records: rows, count: rows.length }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.requestFromRole,
      { displayName: "Request from Role", description: "Send a cross-role request.", parametersSchema: { type: "object", properties: { requestingRoleId: { type: "string" }, targetRoleId: { type: "string" }, kind: { type: "string", enum: ["next_action", "project", "info"] }, body: { type: "string" } }, required: ["requestingRoleId", "targetRoleId", "kind", "body"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { targetRoleId } = params as { targetRoleId: string };
        const parsed = parseZodInput<CrossRoleRequestInput>(crossRoleRequestSchema, params, "request from role");
        if (!parsed.ok) return { content: parsed.error, error: parsed.error };
        const result = await requestFromRole(runCtx.companyId, targetRoleId, {
          ...parsed.value,
          requestingAgentId: parsed.value.requestingAgentId ?? runCtx.agentId ?? undefined,
        });
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.acceptCrossRoleRequest,
      { displayName: "Accept Cross-Role Request", description: "Accept a pending cross-role request.", parametersSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { requestId } = params as { requestId: string };
        const result = await decideCrossRoleRequest(runCtx.companyId, requestId, "accepted");
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.declineCrossRoleRequest,
      { displayName: "Decline Cross-Role Request", description: "Decline a pending cross-role request with a reason.", parametersSchema: { type: "object", properties: { requestId: { type: "string" }, reason: { type: "string" } }, required: ["requestId", "reason"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { requestId, reason } = params as { requestId: string; reason: string };
        if (!reason || !reason.trim()) return { content: "reason is required", error: "validation" };
        const result = await decideCrossRoleRequest(runCtx.companyId, requestId, "declined", reason);
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.row, null, 2) };
      },
    );

    // ── Phase 2 — Elections (Concept 8) ───────────────────────────────
    ctx.data.register("elections-by-circle", async (params) => {
      const circleId = await resolveCircleId(params.circleId as string);
      if (!circleId) return [];
      // JOIN role + requesting/decision agents so the UI can render human names instead of raw UUIDs.
      return await dbCtx!.query<ElectionRequestRow>(
        `SELECT er.*,
                r.name AS target_role_name,
                a.name AS requested_by_agent_name,
                da.name AS decision_agent_name
           FROM ${tbl("role_election_requests")} er
           LEFT JOIN ${tbl("roles")} r ON r.id = er.target_role_id
           LEFT JOIN public.agents a ON a.id = er.requested_by_agent_id
           LEFT JOIN public.agents da ON da.id = er.decision_agent_id
          WHERE er.circle_id = $1
          ORDER BY er.created_at DESC`,
        [circleId],
      );
    });

    ctx.data.register("election-candidates", async (params) => {
      const electionId = params.electionId as string;
      if (!electionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(electionId)) return [];
      return await dbCtx!.query<ElectionCandidateRow>(
        `SELECT * FROM ${tbl("role_election_candidates")} WHERE election_id = $1 ORDER BY composite_score DESC`,
        [electionId],
      );
    });

    ctx.tools.register(
      TOOL_NAMES.requestElection,
      { displayName: "Request Role Election", description: "Open a capability-based election for a target role.", parametersSchema: { type: "object", properties: { circleId: { type: "string" }, targetRoleId: { type: "string" } }, required: ["circleId", "targetRoleId"] } },
      async (params, runCtx): Promise<ToolResult> => {
        const { circleId, targetRoleId } = params as { circleId: string; targetRoleId: string };
        const created = await requestElection(runCtx.companyId, {
          circleId,
          targetRoleId,
          requestedByAgentId: runCtx.agentId ?? null,
        });
        return { content: JSON.stringify(created, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.runElectionScoring,
      { displayName: "Run Election Scoring", description: "Score candidates via 0.7*capability + 0.3*load.", parametersSchema: { type: "object", properties: { electionId: { type: "string" } }, required: ["electionId"] } },
      async (params): Promise<ToolResult> => {
        const { electionId } = params as { electionId: string };
        const result = await runElectionScoring(electionId);
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify({ electionId, candidates: result.candidates }, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.decideElection,
      { displayName: "Decide Election", description: "Assign the role to a chosen candidate.", parametersSchema: { type: "object", properties: { electionId: { type: "string" }, decisionAgentId: { type: "string" } }, required: ["electionId", "decisionAgentId"] } },
      async (params): Promise<ToolResult> => {
        const { electionId, decisionAgentId } = params as { electionId: string; decisionAgentId: string };
        const result = await decideElection(electionId, decisionAgentId);
        if (!result.ok) return { content: result.error, error: result.error };
        return { content: JSON.stringify(result.election, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.cancelElection,
      { displayName: "Cancel Election", description: "Cancel an open or scored election.", parametersSchema: { type: "object", properties: { electionId: { type: "string" } }, required: ["electionId"] } },
      async (params): Promise<ToolResult> => {
        const { electionId } = params as { electionId: string };
        const updated = await cancelElection(electionId);
        if (!updated) return { content: "Election not found", error: "not found" };
        return { content: JSON.stringify(updated, null, 2) };
      },
    );

    // ─── Phase 1.13 — Speech tools (agent voice over A2A-MQTT) ─────────────

    ctx.tools.register(
      TOOL_NAMES.talkToAgent,
      {
        displayName: "Talk to Agent",
        description:
          "Send an A2A Task directly to a peer agent over MQTT. Optionally await the reply on a per-task topic. Set `contextId` to continue a prior conversation thread; if omitted a fresh UUID is minted.",
        parametersSchema: {
          type: "object",
          properties: {
            toAgentId: { type: "string" },
            text: { type: "string" },
            contextId: { type: "string" },
            awaitReply: { type: "boolean" },
            timeoutMs: { type: "number" },
          },
          required: ["toAgentId", "text"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runTalkToAgent(params as TalkToAgentParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.replyOnTask,
      {
        displayName: "Reply on A2A Task",
        description:
          "Publish a Task-state reply for an inbound A2A request the agent is currently working. Use this to emit `input_required` (request clarification) or `failed` before the issue completes; the bridge auto-emits `completed` when the issue closes.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            state: { type: "string", enum: ["completed", "input_required", "failed"] },
            text: { type: "string" },
            artifacts: { type: "array" },
          },
          required: ["issueId", "state"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runReplyOnTask(params as ReplyOnTaskParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.broadcastToCircle,
      {
        displayName: "Broadcast to Circle",
        description:
          "Publish an announcement on a circle's event topic (host-mediated; publisher agentId is stamped in MQTT user properties so receivers know who said it).",
        parametersSchema: {
          type: "object",
          properties: {
            circleId: { type: "string" },
            kind: { type: "string" },
            body: {},
          },
          required: ["circleId", "kind", "body"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runBroadcastToCircle(params as BroadcastToCircleParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.raiseTensionOnBus,
      {
        displayName: "Raise Tension on Bus",
        description:
          "Raise a tension in a circle (persists to DB) AND publish a tension-raised event on the circle's MQTT event topic so every member receives it.",
        parametersSchema: {
          type: "object",
          properties: {
            circleId: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["circleId", "title", "body"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runRaiseTensionOnBus(params as RaiseTensionOnBusParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.askSkill,
      {
        displayName: "Ask Skill (Shared Bus)",
        description:
          "Publish a Task on the skill pool topic; the broker round-robins to one accountability-holder via shared subscription. Cross-circle by design — used for org-wide work distribution by skill name.",
        parametersSchema: {
          type: "object",
          properties: {
            skill: { type: "string" },
            text: { type: "string" },
            contextId: { type: "string" },
            awaitReply: { type: "boolean" },
            timeoutMs: { type: "number" },
          },
          required: ["skill", "text"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runAskSkill(params as AskSkillParams, runCtx);
      },
    );

    // Phase 1.15d/e/g — repair, commit-to-support, 1:1.
    ctx.tools.register(
      TOOL_NAMES.askClarifyingQuestion,
      {
        displayName: "Ask Clarifying Question",
        description:
          "Ask a peer agent a clarifying question about an active discussion. Sidecar to the discussion (NOT counted as a turn). Reuse the same contextId.",
        parametersSchema: {
          type: "object",
          properties: {
            targetAgentId: { type: "string" },
            contextId: { type: "string" },
            question: { type: "string" },
          },
          required: ["targetAgentId", "contextId", "question"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runAskClarifyingQuestion(params as AskClarifyingParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.retractTurn,
      {
        displayName: "Retract Turn",
        description:
          "Cancel a discussion turn you previously made and publish a retraction event on the discussion topic.",
        parametersSchema: {
          type: "object",
          properties: {
            turnIssueId: { type: "string" },
            reason: { type: "string" },
          },
          required: ["turnIssueId", "reason"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runRetractTurn(params as RetractTurnParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.commitToConclusion,
      {
        displayName: "Commit to Conclusion",
        description:
          "Signal your stance (support / support-with-objection / block) on a discussion's conclusion. Blocks only valid from Lead Link/Secretary/Facilitator — otherwise auto-downgraded.",
        parametersSchema: {
          type: "object",
          properties: {
            discussionId: { type: "string" },
            signal: { type: "string", enum: ["support", "support-with-objection", "block"] },
            reason: { type: "string" },
          },
          required: ["discussionId", "signal"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runCommitToConclusion(params as CommitToConclusionParams, runCtx);
      },
    );

    ctx.tools.register(
      TOOL_NAMES.requestOneOnOne,
      {
        displayName: "Request 1:1",
        description:
          "Open a 1:1 discussion (roundtable, 1 round) with a peer agent. Underlying: circle_discussions with circle_id=NULL and explicit participant list.",
        parametersSchema: {
          type: "object",
          properties: {
            withAgentId: { type: "string" },
            topic: { type: "string" },
            initiateNow: { type: "boolean" },
          },
          required: ["withAgentId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        return runRequestOneOnOne(params as RequestOneOnOneParams, runCtx);
      },
    );
  },

  async onApiRequest(input: PluginApiRequestInput) {
    try {
    switch (input.routeKey) {
      case API_ROUTES.listCircles: {
        const companyId = input.companyId;
        const circles = await dbCtx!.query<Circle>(
          `SELECT * FROM ${tbl("circles")} WHERE company_id = $1 ORDER BY parent_circle_id NULLS FIRST, name`,
          [companyId],
        );
        return { status: 200, body: circles };
      }

      case API_ROUTES.getCircle: {
        const detail = await queryCircleDetail(input.params.circleId as string);
        if (!detail) return { status: 404, body: { error: "Circle not found" } };
        return { status: 200, body: detail };
      }

      case API_ROUTES.createCircle: {
        const { name, purpose, parentCircleId, projectId, color } = input.body as {
          name: string; purpose?: string; parentCircleId?: string; projectId?: string; color?: string;
        };
        const result = await createCircle(input.companyId, name, purpose ?? null, parentCircleId ?? null, projectId ?? null, color ?? null);
        return { status: 201, body: result };
      }

      case API_ROUTES.listRoles: {
        const circleId = input.params.circleId as string;
        const roles = await dbCtx!.query<Role>(
          `SELECT r.*, ra.agent_id, a.name as agent_name FROM ${tbl("roles")} r LEFT JOIN ${tbl("role_assignments")} ra ON ra.role_id = r.id LEFT JOIN public.agents a ON a.id = ra.agent_id WHERE r.circle_id = $1 ORDER BY r.role_type, r.name`,
          [circleId],
        );
        return { status: 200, body: roles };
      }

      case API_ROUTES.assignRole: {
        const circleId = input.params.circleId as string;
        const { roleName, roleType, purpose, accountabilities, domains, agentId, actingAgentId } = input.body as {
          roleName: string; roleType?: string; purpose?: string; accountabilities?: string[]; domains?: string[]; agentId?: string; actingAgentId?: string;
        };

        // Concept 9 — Recursive Lead Link assignment authority.
        // When assigning a Lead Link (circle_lead) to a sub-circle, the caller
        // (actingAgentId) must hold a Lead Link in some ancestor circle. Root
        // circles are exempt.
        if (roleType === "circle_lead") {
          const callerCheck = await isAgentLeadLinkInAncestor(actingAgentId ?? null, circleId);
          if (!callerCheck.ok) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
              [input.companyId, actingAgentId ?? null, circleId, JSON.stringify({ code: "parent_lead_link_required", reason: callerCheck.reason, roleType, route: "assignRole" })],
            );
            return { status: 403, body: { error: callerCheck.reason, code: "parent_lead_link_required" } };
          }
          await dbCtx!.execute(
            `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'lead-link-assignment-authority-check', $4)`,
            [input.companyId, actingAgentId ?? null, circleId, JSON.stringify({ ok: true, roleType })],
          );
        }

        // Check domain conflicts if assigning to agent
        if (agentId && domains && domains.length > 0) {
          const conflict = await checkDomainConflict(agentId, domains, input.companyId);
          if (!conflict.ok) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
              [input.companyId, agentId, circleId, JSON.stringify({ violation: conflict.violation, roleName, domains, route: "assignRole" })],
            );
            return { status: 409, body: { error: conflict.violation } };
          }
        }

        const roleId = randomUUID();
        const effectiveRoleType = roleType ?? "custom";
        const defaultRoleNames: Record<string, string> = {
          circle_lead: "Circle Lead",
          facilitator: "Facilitator",
          secretary: "Secretary",
          circle_rep: "Circle Rep",
        };
        const effectiveRoleName = roleName ?? defaultRoleNames[effectiveRoleType];
        if (!effectiveRoleName) {
          return { status: 400, body: { error: "roleName is required for custom roles" } };
        }
        await dbCtx!.execute(
          `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [roleId, circleId, effectiveRoleName, purpose ?? null, effectiveRoleType, JSON.stringify(accountabilities ?? []), JSON.stringify(domains ?? [])],
        );
        if (agentId) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }
        return { status: 201, body: { roleId, roleName, circleId, agentId } };
      }

      case API_ROUTES.updateRole: {
        const circleId = input.params.circleId as string;
        const roleId = input.params.roleId as string;
        const { purpose, accountabilities, domains, name } = input.body as {
          purpose?: string; accountabilities?: string[]; domains?: string[]; name?: string; companyId: string;
        };

        // If domains changing on a role that has an active assignee, validate against registry.
        if (domains !== undefined && domains.length > 0) {
          const assignee = await dbCtx!.query<{ agent_id: string }>(
            `SELECT agent_id FROM ${tbl("role_assignments")} WHERE role_id = $1 LIMIT 1`,
            [roleId],
          );
          if (assignee.length > 0 && assignee[0].agent_id) {
            const conflict = await checkDomainConflict(assignee[0].agent_id, domains, input.companyId, roleId);
            if (!conflict.ok) {
              await dbCtx!.execute(
                `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, role_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-domain-update-rejected', $4)`,
                [input.companyId, assignee[0].agent_id, roleId, JSON.stringify({ violation: conflict.violation, domains, route: "updateRole" })],
              );
              return { status: 409, body: { error: conflict.violation } };
            }
          }
        }

        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (purpose !== undefined) { sets.push(`purpose = $${idx++}`); vals.push(purpose); }
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (accountabilities !== undefined) { sets.push(`accountabilities = $${idx++}`); vals.push(JSON.stringify(accountabilities)); }
        if (domains !== undefined) { sets.push(`domains = $${idx++}`); vals.push(JSON.stringify(domains)); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        sets.push(`updated_at = NOW()`);
        vals.push(roleId, circleId);
        await dbCtx!.execute(
          `UPDATE ${tbl("roles")} SET ${sets.join(", ")} WHERE id = $${idx++} AND circle_id = $${idx}`,
          vals,
        );
        const updated = await dbCtx!.query(`SELECT * FROM ${tbl("roles")} WHERE id = $1`, [roleId]);
        return { status: 200, body: updated[0] ?? { error: "Role not found" } };
      }

      case API_ROUTES.updateCircle: {
        const circleId = input.params.circleId as string;
        const { purpose, name, color, domains, policies } = input.body as {
          purpose?: string; name?: string; color?: string; domains?: unknown; policies?: unknown; companyId: string;
        };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (purpose !== undefined) { sets.push(`purpose = $${idx++}`); vals.push(purpose); }
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (color !== undefined) { sets.push(`color = $${idx++}`); vals.push(color); }
        if (domains !== undefined) { sets.push(`domains = $${idx++}`); vals.push(JSON.stringify(domains)); }
        if (policies !== undefined) { sets.push(`policies = $${idx++}`); vals.push(JSON.stringify(policies)); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        sets.push(`updated_at = NOW()`);
        vals.push(circleId);
        await dbCtx!.execute(
          `UPDATE ${tbl("circles")} SET ${sets.join(", ")} WHERE id = $${idx}`,
          vals,
        );
        const updated = await dbCtx!.query(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        return { status: 200, body: updated[0] ?? { error: "Circle not found" } };
      }

      case API_ROUTES.updateRoleAssignment: {
        const roleId = input.params.roleId as string;
        const { agentId } = input.body as { agentId: string | null; companyId: string };

        // Check domain conflicts before reassignment
        if (agentId) {
          const roleRows = await dbCtx!.query<Role>(
            `SELECT * FROM ${tbl("roles")} WHERE id = $1`,
            [roleId],
          );
          if (roleRows.length === 0) return { status: 404, body: { error: "Role not found" } };
          const role = roleRows[0];
          const roleDomains = Array.isArray(role.domains) ? role.domains :
                              typeof role.domains === 'string' ? JSON.parse(role.domains) : [];
          if (roleDomains.length > 0) {
            // Exclude the current assignment of THIS role from the conflict check
            // (re-assigning same role to same agent should not self-conflict)
            const conflict = await checkDomainConflict(agentId, roleDomains, input.companyId, roleId);
            if (!conflict.ok) {
              await dbCtx!.execute(
                `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, role_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
                [input.companyId, agentId, roleId, JSON.stringify({ violation: conflict.violation, domains: roleDomains, route: "updateRoleAssignment" })],
              );
              return { status: 409, body: { error: conflict.violation } };
            }
          }
        }

        await dbCtx!.execute(`DELETE FROM ${tbl("role_assignments")} WHERE role_id = $1`, [roleId]);
        if (agentId) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }
        return { status: 200, body: { roleId, agentId } };
      }

      case API_ROUTES.deleteCircle: {
        const circleId = input.params.circleId as string;
        await dbCtx!.execute(`DELETE FROM ${tbl("tensions")} WHERE circle_id = $1`, [circleId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("role_assignments")} WHERE role_id IN (SELECT id FROM ${tbl("roles")} WHERE circle_id = $1)`, [circleId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("roles")} WHERE circle_id = $1`, [circleId]);
        await dbCtx!.execute(`UPDATE ${tbl("circles")} SET parent_circle_id = NULL WHERE parent_circle_id = $1`, [circleId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        return { status: 200, body: { deleted: circleId } };
      }

      case API_ROUTES.listTensions: {
        const circleId = input.params.circleId as string;
        const type = input.query?.type as string | undefined;
        const filter = type && type !== "all" ? " AND tension_type = $2" : "";
        const params: unknown[] = filter ? [circleId, type] : [circleId];
        const tensions = await dbCtx!.query<Tension>(
          `SELECT t.*, a.name as agent_name FROM ${tbl("tensions")} t LEFT JOIN public.agents a ON a.id = t.source_agent_id WHERE t.circle_id = $1 AND t.status = 'open'${filter} ORDER BY t.created_at DESC`,
          params,
        );
        return { status: 200, body: tensions };
      }

      case API_ROUTES.raiseTension: {
        const circleId = input.params.circleId as string;
        const { title, description, type: tensionType } = input.body as { title: string; description?: string; type?: string; companyId: string };
        if (!title) return { status: 400, body: { error: "title is required" } };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, circleId, null, title, description ?? null, tensionType ?? "operational"],
        );
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
          [input.companyId, null, circleId, JSON.stringify({ tensionId: id, title, type: tensionType ?? "operational" })],
        );

        // Trigger A: governance tension → auto-create 3-of-3 async approval
        let approvalId: string | undefined;
        if (tensionType === "governance") {
          const approvalResult = await createGovernanceApproval({
            companyId: input.companyId,
            tensionId: id,
            title,
            description: description ?? null,
            requestedByAgentId: null,
          });
          if (approvalResult) {
            approvalId = approvalResult.approvalId;
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'governance-approval-created', $3)`,
              [input.companyId, circleId, JSON.stringify({ tensionId: id, approvalId: approvalResult.approvalId })],
            );
          }
        }

        return {
          status: 201,
          body: {
            tensionId: id,
            title,
            type: tensionType ?? "operational",
            status: "open",
            ...(approvalId ? { approvalId, approvalStatus: "pending" } : {}),
          },
        };
      }

      case API_ROUTES.updateTension: {
        const tensionId = input.params.tensionId as string;
        const { status, resolution } = input.body as { status: string; resolution?: string; companyId: string };
        const validStatuses = ["open", "processing", "resolved", "rejected"];
        if (!validStatuses.includes(status)) return { status: 400, body: { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` } };
        const resolvedAt = status === "resolved" || status === "rejected" ? "NOW()" : "NULL";
        await dbCtx!.execute(
          `UPDATE ${tbl("tensions")} SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2`,
          [status, tensionId],
        );
        if (resolution) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) SELECT $1, circle_id, 'tension-resolved', $3::jsonb FROM ${tbl("tensions")} WHERE id = $2`,
            [input.companyId, tensionId, JSON.stringify({ tensionId, status, resolution })],
          );
        }
        return { status: 200, body: { tensionId, status } };
      }

      case API_ROUTES.getAuditLog: {
        const circleId = input.params.circleId as string;
        const logs = await dbCtx!.query(
          `SELECT al.*, a.name as agent_name FROM ${tbl("audit_log")} al LEFT JOIN public.agents a ON a.id = al.agent_id WHERE al.circle_id = $1 ORDER BY al.created_at DESC LIMIT 200`,
          [circleId],
        );
        return { status: 200, body: logs };
      }

      case API_ROUTES.forwardTension: {
        const circleId = input.params.circleId as string;
        const { tensionId, context } = input.body as { tensionId: string; context: string; companyId: string };
        const tensions = await dbCtx!.query<Tension>(
          `SELECT * FROM ${tbl("tensions")} WHERE id = $1 AND circle_id = $2`,
          [tensionId, circleId],
        );
        if (tensions.length === 0) return { status: 404, body: { error: "Tension not found in this circle" } };
        const sourceTension = tensions[0];
        const circle = await dbCtx!.query<Circle>(`SELECT * FROM ${tbl("circles")} WHERE id = $1`, [circleId]);
        if (!circle[0]?.parent_circle_id) return { status: 400, body: { error: "Circle has no parent circle to forward to" } };
        const forwardedId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type) VALUES ($1, $2, $3, $4, $5, $6)`,
          [forwardedId, circle[0].parent_circle_id, sourceTension.source_agent_id, `[Forwarded] ${sourceTension.title}`, `${context}\n\n---\nOriginal tension from ${circle[0].name}: ${sourceTension.description ?? ""}`, sourceTension.tension_type],
        );
        await dbCtx!.execute(
          `UPDATE ${tbl("tensions")} SET status = 'processing' WHERE id = $1`,
          [tensionId],
        );
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-forwarded', $4)`,
          [input.companyId, sourceTension.source_agent_id, circleId, JSON.stringify({ originalTensionId: tensionId, forwardedTensionId: forwardedId, targetCircleId: circle[0].parent_circle_id, context })],
        );
        return { status: 201, body: { forwardedTensionId: forwardedId, targetCircleId: circle[0].parent_circle_id, originalTensionId: tensionId, status: "forwarded" } };
      }

      case API_ROUTES.recordDecision: {
        const circleId = input.params.circleId as string;
        const { agentId, roleId, decision, context, tensionId, objection } = input.body as {
          agentId?: string; roleId?: string; decision: string; context?: string;
          tensionId?: string; objection?: unknown; companyId: string;
        };

        // Concept 7: three-test objection validity gate.
        // Only applies to governance tensions being rejected. For operational
        // tensions OR approve decisions OR decisions without a tensionId,
        // behaviour is unchanged.
        if (decision === "reject" && tensionId) {
          const tensionRows = await dbCtx!.query<Tension>(
            `SELECT * FROM ${tbl("tensions")} WHERE id = $1`,
            [tensionId],
          );
          const tension = tensionRows[0];
          if (tension && tension.tension_type === "governance") {
            if (objection === undefined || objection === null) {
              return {
                status: 422,
                body: {
                  error: "objection_required",
                  message: "Rejecting a governance tension requires an `objection` block with the three validity tests (unworkable, followsFromProposal, currentNotSpeculation).",
                },
              };
            }
            const parsed = parseObjectionBlock(objection);
            if (!parsed.ok) {
              return {
                status: 422,
                body: { error: "objection_invalid_shape", message: parsed.error },
              };
            }
            const obj = parsed.value;
            const failedTests: string[] = [];
            if (obj.unworkable.result !== true) failedTests.push("unworkable");
            if (obj.followsFromProposal.result !== true) failedTests.push("followsFromProposal");
            if (obj.currentNotSpeculation.result !== true) failedTests.push("currentNotSpeculation");
            if (failedTests.length > 0) {
              return {
                status: 422,
                body: {
                  error: "objection_invalid",
                  message: `Objection failed required test(s): ${failedTests.join(", ")}. All three tests must have result=true with a non-empty rationale for a governance rejection to be valid.`,
                  failedTests,
                },
              };
            }

            // Valid objection — record it before the generic decision entry.
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (id, company_id, agent_id, role_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, $4, $5, 'governance-objection-recorded', $6)`,
              [
                randomUUID(),
                input.companyId,
                agentId ?? null,
                roleId ?? null,
                circleId,
                JSON.stringify({
                  tensionId,
                  tensionTitle: tension.title,
                  decision: "reject",
                  objection: obj,
                  isValid: true,
                  context: context ?? null,
                }),
              ],
            );
          }
        }

        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (id, company_id, agent_id, role_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, $4, $5, 'decision', $6)`,
          [id, input.companyId, agentId ?? null, roleId ?? null, circleId, JSON.stringify({ decision, context, tensionId: tensionId ?? null, objection: objection ?? null })],
        );
        return { status: 201, body: { id, actionType: "decision", decision } };
      }

      case API_ROUTES.listPolicies: {
        const circleId = input.params.circleId as string;
        const policies = await dbCtx!.query(
          `SELECT * FROM ${tbl("policies")} WHERE circle_id = $1 ORDER BY created_at DESC`,
          [circleId],
        );
        return { status: 200, body: policies };
      }

      case API_ROUTES.createPolicy: {
        const circleId = input.params.circleId as string;
        const { title, description, domain } = input.body as { title: string; description: string; domain?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("policies")} (id, circle_id, title, description, domain) VALUES ($1, $2, $3, $4, $5)`,
          [id, circleId, title, description, domain ?? null],
        );
        return { status: 201, body: { id, circleId, title, description, domain } };
      }

      case API_ROUTES.updatePolicy: {
        const policyId = input.params.policyId as string;
        const { title, description, domain } = input.body as { title?: string; description?: string; domain?: string; companyId: string };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title); }
        if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
        if (domain !== undefined) { sets.push(`domain = $${idx++}`); vals.push(domain); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        sets.push(`updated_at = NOW()`);
        vals.push(policyId);
        await dbCtx!.execute(`UPDATE ${tbl("policies")} SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
        return { status: 200, body: { policyId, updated: true } };
      }

      case API_ROUTES.deletePolicy: {
        const policyId = input.params.policyId as string;
        await dbCtx!.execute(`DELETE FROM ${tbl("policies")} WHERE id = $1`, [policyId]);
        return { status: 200, body: { deleted: policyId } };
      }

      case API_ROUTES.listChecklists: {
        const circleId = input.params.circleId as string;
        const checklists = await dbCtx!.query(
          `SELECT cl.*, r.name as role_name FROM ${tbl("checklists")} cl LEFT JOIN ${tbl("roles")} r ON r.id = cl.role_id WHERE cl.circle_id = $1 ORDER BY cl.created_at`,
          [circleId],
        );
        return { status: 200, body: checklists };
      }

      case API_ROUTES.createChecklist: {
        const circleId = input.params.circleId as string;
        const { itemText, roleId, frequency } = input.body as { itemText: string; roleId?: string; frequency?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("checklists")} (id, circle_id, role_id, item_text, frequency) VALUES ($1, $2, $3, $4, $5)`,
          [id, circleId, roleId ?? null, itemText, frequency ?? "weekly"],
        );
        return { status: 201, body: { id, circleId, itemText, frequency: frequency ?? "weekly" } };
      }

      case API_ROUTES.respondChecklist: {
        const checklistId = input.params.checklistId as string;
        const { checked, periodDate, agentId } = input.body as { checked: boolean; periodDate: string; agentId?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("checklist_responses")} (id, checklist_id, agent_id, checked, period_date) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [id, checklistId, agentId ?? null, checked, periodDate],
        );
        return { status: 200, body: { checklistId, checked, periodDate } };
      }

      case API_ROUTES.listMetrics: {
        const circleId = input.params.circleId as string;
        const metrics = await dbCtx!.query(
          `SELECT m.*, r.name as role_name FROM ${tbl("metrics")} m LEFT JOIN ${tbl("roles")} r ON r.id = m.role_id WHERE m.circle_id = $1 ORDER BY m.created_at`,
          [circleId],
        );
        return { status: 200, body: metrics };
      }

      case API_ROUTES.createMetric: {
        const circleId = input.params.circleId as string;
        const { name, description, unit, roleId, frequency } = input.body as { name: string; description?: string; unit?: string; roleId?: string; frequency?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("metrics")} (id, circle_id, role_id, name, description, unit, frequency) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, circleId, roleId ?? null, name, description ?? null, unit ?? null, frequency ?? "weekly"],
        );
        return { status: 201, body: { id, circleId, name, unit, frequency: frequency ?? "weekly" } };
      }

      case API_ROUTES.reportMetric: {
        const metricId = input.params.metricId as string;
        const { value, periodDate, reportedBy } = input.body as { value: number; periodDate: string; reportedBy?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("metric_values")} (id, metric_id, value, period_date, reported_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, metricId, value, periodDate, reportedBy ?? null],
        );
        return { status: 201, body: { id, metricId, value, periodDate } };
      }

      case API_ROUTES.listStrategies: {
        const circleId = input.params.circleId as string;
        const strategies = await dbCtx!.query(
          `SELECT s.*, a.name as set_by_name FROM ${tbl("strategies")} s LEFT JOIN public.agents a ON a.id = s.set_by WHERE s.circle_id = $1 AND s.active = true ORDER BY s.created_at DESC`,
          [circleId],
        );
        return { status: 200, body: strategies };
      }

      case API_ROUTES.createStrategy: {
        const circleId = input.params.circleId as string;
        const { text, setBy } = input.body as { text: string; setBy?: string; companyId: string };
        const id = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("strategies")} (id, circle_id, text, set_by) VALUES ($1, $2, $3, $4)`,
          [id, circleId, text, setBy ?? null],
        );
        return { status: 201, body: { id, circleId, text } };
      }

      case API_ROUTES.updateStrategy: {
        const strategyId = input.params.strategyId as string;
        const { text, active } = input.body as { text?: string; active?: boolean; companyId: string };
        const sets: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;
        if (text !== undefined) { sets.push(`text = $${idx++}`); vals.push(text); }
        if (active !== undefined) { sets.push(`active = $${idx++}`); vals.push(active); }
        if (sets.length === 0) return { status: 400, body: { error: "No fields to update" } };
        vals.push(strategyId);
        await dbCtx!.execute(`UPDATE ${tbl("strategies")} SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
        return { status: 200, body: { strategyId, updated: true } };
      }

      case API_ROUTES.onboardAgent: {
        const circleId = input.params.circleId as string;
        const { agentId, roleName, rolePurpose, roleAccountabilities, roleDomains } = input.body as {
          agentId?: string; roleName: string; rolePurpose: string;
          roleAccountabilities?: string[]; roleDomains?: string[];
          companyId: string;
        };

        // Check domain conflicts before creating role + assignment
        if (agentId && roleDomains && roleDomains.length > 0) {
          const conflict = await checkDomainConflict(agentId, roleDomains, input.companyId);
          if (!conflict.ok) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'role-assignment-rejected', $4)`,
              [input.companyId, agentId, circleId, JSON.stringify({ violation: conflict.violation, roleName, domains: roleDomains, route: "onboardAgent" })],
            );
            return { status: 409, body: { error: conflict.violation } };
          }
        }

        const roleId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("roles")} (id, circle_id, name, purpose, role_type, accountabilities, domains) VALUES ($1, $2, $3, $4, 'custom', $5, $6)`,
          [roleId, circleId, roleName, rolePurpose, JSON.stringify(roleAccountabilities ?? []), JSON.stringify(roleDomains ?? [])],
        );
        if (agentId) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("role_assignments")} (id, role_id, agent_id) VALUES ($1, $2, $3)`,
            [randomUUID(), roleId, agentId],
          );
        }
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, circle_id, action_type, action_detail) VALUES ($1, $2, 'agent-onboarded', $3)`,
          [input.companyId, circleId, JSON.stringify({ roleId, roleName, agentId, rolePurpose })],
        );
        return { status: 201, body: { roleId, roleName, circleId, agentId } };
      }

      case API_ROUTES.accountabilityScan: {
        // Nightly accountability scanner — evaluates pre-approved metrics against
        // agent accountabilities and files operational tensions for breaches.
        // Idempotency key: "<agentId>:<accountabilityName>:<YYYY-MM-DD>" prevents
        // duplicate tensions for the same (agent, accountability, day).
        const companyId = input.companyId;
        const rawScanDate = (input.body as { scanDate?: string } | undefined)?.scanDate;
        const scanDate = rawScanDate ?? new Date().toISOString().slice(0, 10);

        // Load all agents with accountabilities for this company
        const agents = await dbCtx!.query<{
          id: string;
          name: string;
          accountabilities: Array<{
            name: string;
            metric: string;
            target: number | string | boolean;
            alert_threshold: number | string | boolean;
            alert_direction?: "higher_is_better" | "lower_is_better";
            cadence: "hourly" | "daily" | "weekly" | "monthly";
            escalation_path?: string[];
          }>;
        }>(
          `SELECT id, name, accountabilities FROM public.agents WHERE company_id = $1 AND status != 'deleted'`,
          [companyId],
        );

        // Determine which cadences are "due now" for this scan.
        // Scanner runs daily — hourly and daily are always due; weekly on Monday; monthly on 1st.
        const dayOfWeek = new Date(scanDate + "T12:00:00Z").getDay(); // 0=Sun, use UTC noon to avoid TZ edge
        const dayOfMonth = parseInt(scanDate.slice(8, 10), 10);
        const dueCadences = new Set<string>(["hourly", "daily"]);
        if (dayOfWeek === 1) dueCadences.add("weekly");
        if (dayOfMonth === 1) dueCadences.add("monthly");

        // Find the GCC (root circle) for this company to use as fallback
        const gccRows = await dbCtx!.query<{ id: string }>(
          `SELECT id FROM ${tbl("circles")} WHERE company_id = $1 AND parent_circle_id IS NULL LIMIT 1`,
          [companyId],
        );
        const fallbackCircleId = gccRows[0]?.id;
        if (!fallbackCircleId) {
          return { status: 400, body: { error: "No root circle found for company" } };
        }

        // Helper: evaluate a pre-approved metric expression.
        // Returns number or boolean, or null if metric unknown.
        const evaluateMetric = async (
          agentId: string,
          metric: string,
        ): Promise<number | boolean | null> => {
          const m = metric.trim().toLowerCase();

          // "count of engineering issues marked done this week"
          if (m === "count of engineering issues marked done this week") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "average hours from pr opened to first review"
          if (m === "average hours from pr opened to first review") {
            // Proxy: avg hours issues in_review, updated within 7d
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - created_at))/3600, 0)::float as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_review' AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "count of backlog issues triaged and prioritized this week"
          if (m === "count of backlog issues triaged and prioritized this week") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status != 'backlog' AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "days since last roadmap update"
          if (m === "days since last roadmap update") {
            const rows = await dbCtx!.query<{ days: number | null }>(
              `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))/86400 as days FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2`,
              [companyId, agentId],
            );
            return rows[0]?.days ?? 9999;
          }

          // "count of coordination issues resolved or escalated this week"
          if (m === "count of coordination issues resolved or escalated this week") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status IN ('done','cancelled') AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "count of unassigned backlog issues older than 24h"
          if (m === "count of unassigned backlog issues older than 24h") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id IS NULL AND status = 'backlog' AND created_at < NOW() - INTERVAL '24 hours'`,
              [companyId],
            );
            return rows[0]?.count ?? 0;
          }

          // "days since last strategy heuristic update"
          if (m === "days since last strategy heuristic update") {
            const rows = await dbCtx!.query<{ days: number | null }>(
              `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(s.created_at)))/86400 as days FROM ${tbl("strategies")} s JOIN ${tbl("circles")} c ON c.id = s.circle_id WHERE c.company_id = $1`,
              [companyId],
            );
            return rows[0]?.days ?? 9999;
          }

          // "count of strategy documents published this month"
          if (m === "count of strategy documents published this month") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM ${tbl("strategies")} s JOIN ${tbl("circles")} c ON c.id = s.circle_id WHERE c.company_id = $1 AND s.created_at >= date_trunc('month', NOW())`,
              [companyId],
            );
            return rows[0]?.count ?? 0;
          }

          // "ratio of correctly routed issues to total routed issues"
          if (m === "ratio of correctly routed issues to total routed issues") {
            const rows = await dbCtx!.query<{ ratio: number | null }>(
              `SELECT CASE WHEN COUNT(*) = 0 THEN 1.0 ELSE COUNT(*) FILTER (WHERE status != 'backlog')::float / COUNT(*) END as ratio FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.ratio ?? 1.0;
          }

          // "ratio of passing regression tests to total regression tests" — static 1.0 (no test infra tracked in DB)
          if (m === "ratio of passing regression tests to total regression tests") {
            return 1.0; // assume passing unless external data shows otherwise
          }

          // "average hours from build ready to qa sign-off"
          if (m === "average hours from build ready to qa sign-off") {
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - created_at))/3600, 0)::float as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_review' AND updated_at >= NOW() - INTERVAL '30 days'`,
              [companyId, agentId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "average hours from tension raised to governance proposal filed"
          if (m === "average hours from tension raised to governance proposal filed") {
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - created_at))/3600, 0)::float as avg_hours FROM ${tbl("tensions")} WHERE circle_id IN (SELECT id FROM ${tbl("circles")} WHERE company_id = $1) AND status = 'open' AND created_at >= NOW() - INTERVAL '30 days'`,
              [companyId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "count of workflow automation scripts deployed this month"
          if (m === "count of workflow automation scripts deployed this month") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= date_trunc('month', NOW())`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // "average hours from message received to response"
          if (m === "average hours from message received to response") {
            // Proxy: avg hours issues assigned to agent that moved from todo→in_progress within 24h
            const rows = await dbCtx!.query<{ avg_hours: number | null }>(
              `SELECT COALESCE(EXTRACT(EPOCH FROM AVG(NOW() - updated_at))/3600, 0)::float as avg_hours FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'in_progress' AND updated_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.avg_hours ?? 0;
          }

          // "agent is actively assigned to issues this month"
          if (m === "agent is actively assigned to issues this month") {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND (status = 'in_progress' OR (status = 'done' AND completed_at >= date_trunc('month', NOW())))`,
              [companyId, agentId],
            );
            return (rows[0]?.count ?? 0) > 0;
          }

          // Machine-readable legacy formats (backward compat)
          if (/^count\(issues where assignee=AGENT and status=done and completedAt>=now-7d\)$/i.test(metric)) {
            const rows = await dbCtx!.query<{ count: number }>(
              `SELECT COUNT(*)::int as count FROM public.issues WHERE company_id = $1 AND assignee_agent_id = $2 AND status = 'done' AND completed_at >= NOW() - INTERVAL '7 days'`,
              [companyId, agentId],
            );
            return rows[0]?.count ?? 0;
          }

          // boolean(true/false) literal
          const boolMatch = metric.match(/^boolean\((true|false)\)$/i);
          if (boolMatch) return boolMatch[1].toLowerCase() === "true";

          // Unknown metric — skip (no arbitrary SQL execution)
          console.warn(`[holacracy:scan] Unknown metric pattern, skipping: "${metric}"`);
          return null;
        };

        // Helper: check if metric value breaches threshold
        // Respects alert_direction: higher_is_better vs lower_is_better
        const breaches = (
          value: number | boolean,
          threshold: number | string | boolean,
          metric: string,
          direction?: "higher_is_better" | "lower_is_better",
        ): boolean => {
          if (typeof value === "boolean") {
            // breach if value !== expected (threshold is the expected value)
            return value !== threshold;
          }
          const numThreshold = threshold as number;
          
          // If direction explicitly set, use it
          if (direction === "lower_is_better") {
            return value > numThreshold;
          }
          if (direction === "higher_is_better") {
            return value < numThreshold;
          }
          
          // Infer from metric name if direction not specified
          const isExceedsMetric =
            /^days since/.test(metric) ||
            /^count of unassigned/.test(metric) ||
            /^ratio/.test(metric) ||
            /^average hours/.test(metric) ||
            /latency|turnaround|hours/.test(metric);
          if (isExceedsMetric) {
            return value > numThreshold; // lower_is_better
          }
          // Higher is better for completion/published/deployed metrics
          return value < numThreshold;
        };

        const tensionsRaised: Array<{ agentId: string; accountability: string; tensionId: string }> = [];
        const tensionsSkipped: Array<{ agentId: string; accountability: string; reason: string }> = [];

        for (const agent of agents) {
          let accs = Array.isArray(agent.accountabilities) ? agent.accountabilities : [];

          // HOTFIX MYA-143: Dev Lead engineering_issues_completed_weekly threshold correction
          // API layer not persisting alert_direction field; apply override here until database is migrated
          if (agent.id === "e1f66962-dc3c-4a8e-9875-de1a1dee2839") {
            accs = accs.map((acc) => {
              if (acc.name === "engineering_issues_completed_weekly") {
                return {
                  ...acc,
                  alert_threshold: 5, // from 9999 (data entry error)
                  alert_direction: "higher_is_better" as const,
                };
              }
              return acc;
            });
          }

          for (const acc of accs) {
            if (!dueCadences.has(acc.cadence)) {
              continue; // not due today
            }

            const idempotencyKey = `scan:${agent.id}:${acc.name}:${scanDate}`;

            // Dedup check — skip if tension already filed today
            const existing = await dbCtx!.query<{ id: string }>(
              `SELECT id FROM ${tbl("tensions")} WHERE idempotency_key = $1 LIMIT 1`,
              [idempotencyKey],
            );
            if (existing.length > 0) {
              tensionsSkipped.push({ agentId: agent.id, accountability: acc.name, reason: "duplicate" });
              continue;
            }

            // Evaluate metric
            let metricValue: number | boolean | null = null;
            try {
              metricValue = await evaluateMetric(agent.id, acc.metric);
            } catch (err) {
              console.error(`[holacracy:scan] metric eval error for ${agent.name}/${acc.name}:`, err);
              tensionsSkipped.push({ agentId: agent.id, accountability: acc.name, reason: "metric_error" });
              continue;
            }

            if (metricValue === null) {
              tensionsSkipped.push({ agentId: agent.id, accountability: acc.name, reason: "unknown_metric" });
              continue;
            }

            if (!breaches(metricValue, acc.alert_threshold, acc.metric, acc.alert_direction)) {
              continue; // within threshold, no tension
            }

            // Find this agent's circle (first role_assignment → circle)
            const circleRows = await dbCtx!.query<{ circle_id: string }>(
              `SELECT r.circle_id FROM ${tbl("role_assignments")} ra JOIN ${tbl("roles")} r ON r.id = ra.role_id WHERE ra.agent_id = $1 LIMIT 1`,
              [agent.id],
            );
            const circleId = circleRows[0]?.circle_id ?? fallbackCircleId;

            // Determine assignee (escalation_path[0] || agent itself)
            const escalateTo = acc.escalation_path?.[0] ?? agent.id;

            const tensionId = randomUUID();
            const title = `[Scanner] ${agent.name} breached ${acc.name}: ${metricValue} vs threshold ${acc.alert_threshold}`;
            const description = JSON.stringify({
              agent_id: agent.id,
              accountability_name: acc.name,
              metric_expression: acc.metric,
              metric_value: metricValue,
              alert_threshold: acc.alert_threshold,
              cadence: acc.cadence,
              observed_at: new Date().toISOString(),
              scan_date: scanDate,
              escalate_to: escalateTo,
            });

            await dbCtx!.execute(
              `INSERT INTO ${tbl("tensions")} (id, circle_id, source_agent_id, title, description, tension_type, idempotency_key) VALUES ($1, $2, $3, $4, $5, 'operational', $6)`,
              [tensionId, circleId, agent.id, title, description, idempotencyKey],
            );

            await dbCtx!.execute(
              `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
              [
                companyId,
                agent.id,
                circleId,
                JSON.stringify({ tensionId, source: "accountability-scanner", accountability: acc.name, scanDate }),
              ],
            );

            // Also write to GCC so company-level audit log surfaces scanner activity
            if (circleId !== fallbackCircleId) {
              await dbCtx!.execute(
                `INSERT INTO ${tbl("audit_log")} (company_id, agent_id, circle_id, action_type, action_detail) VALUES ($1, $2, $3, 'tension-raised', $4)`,
                [
                  companyId,
                  agent.id,
                  fallbackCircleId,
                  JSON.stringify({ tensionId, source: "accountability-scanner", accountability: acc.name, scanDate, subCircleId: circleId }),
                ],
              );
            }

            tensionsRaised.push({ agentId: agent.id, accountability: acc.name, tensionId });
          }
        }

        return {
          status: 200,
          body: {
            scanDate,
            agentsScanned: agents.length,
            tensionsRaised: tensionsRaised.length,
            tensionsSkipped: tensionsSkipped.length,
            raised: tensionsRaised,
            skipped: tensionsSkipped,
          },
        };
      }

      case API_ROUTES.listWorkflows: {
        const circleId = input.params.circleId as string;
        const rows = await dbCtx!.query<{
          id: string; circle_id: string; name: string; description: string | null; trigger: string | null; created_at: string; updated_at: string;
        }>(`SELECT * FROM ${tbl("workflows")} WHERE circle_id = $1 ORDER BY name`, [circleId]);
        const result = [];
        for (const w of rows) {
          const steps = await dbCtx!.query(`SELECT * FROM ${tbl("workflow_steps")} WHERE workflow_id = $1 ORDER BY step_number`, [w.id]);
          result.push({ ...w, steps });
        }
        return { status: 200, body: result };
      }

      case API_ROUTES.createWorkflow: {
        const circleId = input.params.circleId as string;
        const b = input.body as { name: string; description?: string; trigger?: string; steps?: Array<{ step_number: number; role_name: string; title: string; inputs?: string[]; outputs?: string[]; sla_days?: number; blocks_next_step?: boolean }> };
        if (!b.name) return { status: 400, body: { error: "name required" } };
        const wfId = randomUUID();
        await dbCtx!.execute(
          `INSERT INTO ${tbl("workflows")} (id, circle_id, name, description, trigger) VALUES ($1, $2, $3, $4, $5)`,
          [wfId, circleId, b.name, b.description ?? null, b.trigger ?? null],
        );
        const steps = b.steps ?? [];
        for (const s of steps) {
          await dbCtx!.execute(
            `INSERT INTO ${tbl("workflow_steps")} (id, workflow_id, step_number, role_name, title, inputs, outputs, sla_days, blocks_next_step) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9)`,
            [randomUUID(), wfId, s.step_number, s.role_name, s.title, s.inputs ?? [], s.outputs ?? [], s.sla_days ?? 1, s.blocks_next_step ?? true],
          );
        }
        const created = await dbCtx!.query(`SELECT * FROM ${tbl("workflows")} WHERE id = $1`, [wfId]);
        const createdSteps = await dbCtx!.query(`SELECT * FROM ${tbl("workflow_steps")} WHERE workflow_id = $1 ORDER BY step_number`, [wfId]);
        return { status: 201, body: { ...created[0], steps: createdSteps } };
      }

      case API_ROUTES.getWorkflow: {
        const circleId = input.params.circleId as string;
        const workflowId = input.params.workflowId as string;
        const rows = await dbCtx!.query(`SELECT * FROM ${tbl("workflows")} WHERE id = $1 AND circle_id = $2`, [workflowId, circleId]);
        if (!rows.length) return { status: 404, body: { error: "Workflow not found" } };
        const steps = await dbCtx!.query(`SELECT * FROM ${tbl("workflow_steps")} WHERE workflow_id = $1 ORDER BY step_number`, [workflowId]);
        return { status: 200, body: { ...rows[0], steps } };
      }

      case API_ROUTES.updateWorkflow: {
        const circleId = input.params.circleId as string;
        const workflowId = input.params.workflowId as string;
        const b = input.body as { name?: string; description?: string; trigger?: string; steps?: Array<{ step_number: number; role_name: string; title: string; inputs?: string[]; outputs?: string[]; sla_days?: number; blocks_next_step?: boolean }> };
        const existing = await dbCtx!.query(`SELECT id FROM ${tbl("workflows")} WHERE id = $1 AND circle_id = $2`, [workflowId, circleId]);
        if (!existing.length) return { status: 404, body: { error: "Workflow not found" } };
        if (b.name !== undefined || b.description !== undefined || b.trigger !== undefined) {
          const updates: string[] = [];
          const vals: unknown[] = [];
          let i = 1;
          if (b.name !== undefined) { updates.push(`name = $${i++}`); vals.push(b.name); }
          if (b.description !== undefined) { updates.push(`description = $${i++}`); vals.push(b.description); }
          if (b.trigger !== undefined) { updates.push(`trigger = $${i++}`); vals.push(b.trigger); }
          updates.push(`updated_at = NOW()`);
          vals.push(workflowId);
          await dbCtx!.execute(`UPDATE ${tbl("workflows")} SET ${updates.join(", ")} WHERE id = $${i}`, vals);
        }
        if (b.steps !== undefined) {
          await dbCtx!.execute(`DELETE FROM ${tbl("workflow_steps")} WHERE workflow_id = $1`, [workflowId]);
          for (const s of b.steps) {
            await dbCtx!.execute(
              `INSERT INTO ${tbl("workflow_steps")} (id, workflow_id, step_number, role_name, title, inputs, outputs, sla_days, blocks_next_step) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9)`,
              [randomUUID(), workflowId, s.step_number, s.role_name, s.title, s.inputs ?? [], s.outputs ?? [], s.sla_days ?? 1, s.blocks_next_step ?? true],
            );
          }
        }
        const updated = await dbCtx!.query(`SELECT * FROM ${tbl("workflows")} WHERE id = $1`, [workflowId]);
        const updatedSteps = await dbCtx!.query(`SELECT * FROM ${tbl("workflow_steps")} WHERE workflow_id = $1 ORDER BY step_number`, [workflowId]);
        return { status: 200, body: { ...updated[0], steps: updatedSteps } };
      }

      case API_ROUTES.deleteWorkflow: {
        const circleId = input.params.circleId as string;
        const workflowId = input.params.workflowId as string;
        const existing = await dbCtx!.query(`SELECT id FROM ${tbl("workflows")} WHERE id = $1 AND circle_id = $2`, [workflowId, circleId]);
        if (!existing.length) return { status: 404, body: { error: "Workflow not found" } };
        await dbCtx!.execute(`DELETE FROM ${tbl("workflow_steps")} WHERE workflow_id = $1`, [workflowId]);
        await dbCtx!.execute(`DELETE FROM ${tbl("workflows")} WHERE id = $1`, [workflowId]);
        return { status: 200, body: { deleted: true } };
      }

      case API_ROUTES.applyWorkflow: {
        const issueId = input.params.issueId as string;
        const b = input.body as { workflowId: string; companyId: string; projectId?: string };
        if (!b.workflowId) return { status: 400, body: { error: "workflowId required" } };
        const parentIssues = await dbCtx!.query<{ id: string; title: string; identifier: string; project_id: string | null }>(
          `SELECT id, title, identifier, project_id FROM public.issues WHERE id = $1`,
          [issueId],
        );
        if (!parentIssues.length) return { status: 404, body: { error: "Parent issue not found" } };
        const parent = parentIssues[0];
        const wfRows = await dbCtx!.query<{ id: string; name: string; circle_id: string }>(`SELECT * FROM ${tbl("workflows")} WHERE id = $1`, [b.workflowId]);
        if (!wfRows.length) return { status: 404, body: { error: "Workflow not found" } };
        const steps = await dbCtx!.query<{
          step_number: number; role_name: string; title: string; inputs: string[]; outputs: string[]; sla_days: number; blocks_next_step: boolean;
        }>(`SELECT * FROM ${tbl("workflow_steps")} WHERE workflow_id = $1 ORDER BY step_number`, [b.workflowId]);
        if (!steps.length) return { status: 400, body: { error: "Workflow has no steps" } };
        const createdIssues: Array<{ step: number; issueId: string; title: string }> = [];
        let prevIssueId: string | undefined;
        for (const step of steps) {
          const stepTitle = `[${parent.identifier}] ${step.role_name} - ${step.title}`;
          const stepDesc = [
            `**Step ${step.step_number} of ${steps.length}** — ${step.role_name}`,
            ``,
            `**What to do:** ${step.title}`,
            step.inputs.length ? `\n**Inputs required:**\n${step.inputs.map((inp: string) => `- ${inp}`).join("\n")}` : "",
            step.outputs.length ? `\n**Expected outputs:**\n${step.outputs.map((out: string) => `- ${out}`).join("\n")}` : "",
            `\n**SLA:** ${step.sla_days} day(s)`,
            `\n*Part of workflow: ${wfRows[0].name}*`,
          ].filter(Boolean).join("\n");
          const created = await issuesCtx!.create({
            companyId: b.companyId,
            parentId: issueId,
            projectId: b.projectId ?? parent.project_id ?? undefined,
            title: stepTitle,
            description: stepDesc,
            status: step.step_number === 1 ? "todo" : "backlog",
            blockedByIssueIds: (step.blocks_next_step && prevIssueId && step.step_number > 1) ? [prevIssueId] : [],
            originKind: "plugin:paperclipai.plugin-holacracy:workflow-step",
            originId: `${b.workflowId}:step-${step.step_number}`,
          });
          createdIssues.push({ step: step.step_number, issueId: created.id, title: stepTitle });
          prevIssueId = created.id;
        }
        return { status: 201, body: { workflowId: b.workflowId, parentIssueId: issueId, stepsCreated: createdIssues.length, steps: createdIssues } };
      }

      case API_ROUTES.listCircleAgreements: {
        const circleId = input.params.circleId as string;
        const rows = await listAgreementsForCircle(circleId);
        return { status: 200, body: rows };
      }

      case API_ROUTES.createAgreement: {
        const parsed = parseCreateAgreementInput(input.body);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const created = await createAgreement({ companyId: input.companyId, ...parsed.value });
        return { status: 201, body: created };
      }

      case API_ROUTES.activateAgreement: {
        const id = input.params.id as string;
        const updated = await activateAgreement(id);
        if (!updated) return { status: 404, body: { error: "Agreement not found" } };
        return { status: 200, body: updated };
      }

      case API_ROUTES.revokeAgreement: {
        const id = input.params.id as string;
        const { reason } = (input.body ?? {}) as { reason?: string };
        if (!reason || !reason.trim()) return { status: 400, body: { error: "reason is required" } };
        const updated = await revokeAgreement(id, reason);
        if (!updated) return { status: 404, body: { error: "Agreement not found" } };
        return { status: 200, body: updated };
      }

      // ── IDM (Integrative Decision-Making) ─────────────────────────────
      case API_ROUTES.idmPropose: {
        const parsed = parseZodInput<IdmProposeInput>(idmProposeSchema, input.body, "idm propose");
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const result = await idmPropose({ companyId: input.companyId, ...parsed.value });
        return { status: 201, body: result };
      }

      case API_ROUTES.idmGet: {
        const id = input.params.id as string;
        const idm = await loadIdm(id);
        if (!idm) return { status: 404, body: { error: "IDM not found" } };
        const inputs = await loadIdmInputs(id);
        const objections = await loadIdmObjections(id);
        return { status: 200, body: { idm, inputs, objections } };
      }

      case API_ROUTES.idmAddQuestion: {
        const id = input.params.id as string;
        const { body, agentId, roleId } = (input.body ?? {}) as { body?: string; agentId?: string; roleId?: string };
        if (!body || !body.trim()) return { status: 400, body: { error: "body is required" } };
        if (!agentId) return { status: 400, body: { error: "agentId is required" } };
        const result = await idmAddInput({ idmId: id, kind: "question", agentId, roleId, payload: { body } });
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 201, body: result.row };
      }

      case API_ROUTES.idmAddReaction: {
        const id = input.params.id as string;
        const { body, agentId, roleId } = (input.body ?? {}) as { body?: string; agentId?: string; roleId?: string };
        if (!body || !body.trim()) return { status: 400, body: { error: "body is required" } };
        if (!agentId) return { status: 400, body: { error: "agentId is required" } };
        const result = await idmAddInput({ idmId: id, kind: "reaction", agentId, roleId, payload: { body } });
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 201, body: result.row };
      }

      case API_ROUTES.idmAddAmendment: {
        const id = input.params.id as string;
        const { body, agentId, roleId, content } = (input.body ?? {}) as { body?: string; agentId?: string; roleId?: string; content?: unknown };
        if (!body || !body.trim()) return { status: 400, body: { error: "body is required" } };
        if (!agentId) return { status: 400, body: { error: "agentId is required" } };
        const payload: Record<string, unknown> = { body };
        if (content !== undefined) payload.content = content;
        const result = await idmAddInput({ idmId: id, kind: "amendment", agentId, roleId, payload });
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 201, body: result.row };
      }

      case API_ROUTES.idmRaiseObjection: {
        const id = input.params.id as string;
        const { body, agentId, roleId } = (input.body ?? {}) as { body?: string; agentId?: string; roleId?: string };
        if (!body || !body.trim()) return { status: 400, body: { error: "body is required" } };
        if (!agentId) return { status: 400, body: { error: "agentId is required" } };
        const result = await idmObject({ idmId: id, raisedByAgentId: agentId, raisedByRoleId: roleId, body });
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 201, body: result.row };
      }

      case API_ROUTES.idmValidateObjection: {
        const objectionId = input.params.id as string;
        const parsed = parseZodInput(idmValidateObjectionSchema, input.body, "idm validate objection");
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const updated = await idmValidateObjection(objectionId, parsed.value.tests);
        if (!updated) return { status: 404, body: { error: "Objection not found" } };
        return { status: 200, body: updated };
      }

      case API_ROUTES.idmIntegrate: {
        const id = input.params.id as string;
        const { agentId } = (input.body ?? {}) as { agentId?: string };
        if (!agentId) return { status: 400, body: { error: "agentId is required" } };
        const parsed = parseZodInput<IdmIntegrateInput>(idmIntegrateSchema, input.body, "idm integrate");
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const result = await idmIntegrate({
          idmId: id,
          objectionId: parsed.value.objectionId,
          amendment: parsed.value.amendment,
          agentId,
          roleId: parsed.value.roleId,
        });
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 200, body: result };
      }

      case API_ROUTES.idmAdvance: {
        const id = input.params.id as string;
        const updated = await idmAdvance(id);
        if (!updated) return { status: 404, body: { error: "IDM not found" } };
        return { status: 200, body: updated };
      }

      // ── Phase 2 — Concept 1: Cross-links ──────────────────────────────
      case API_ROUTES.createCrossLink: {
        const parsed = parseZodInput<CreateCrossLinkInput>(createCrossLinkSchema, input.body, "create cross-link");
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const result = await createCrossLink(input.companyId, parsed.value);
        if (!result.ok) return { status: 400, body: { error: result.error } };
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, action_type, action_detail) VALUES ($1, 'cross-link-created', $2)`,
          [input.companyId, JSON.stringify({ crossLinkId: result.row.id, circleAId: parsed.value.circleAId, circleBId: parsed.value.circleBId })],
        );
        await publishCrossLinkEvent(result.row, "cross_link.created");
        return { status: 201, body: result.row };
      }

      case API_ROUTES.listCircleCrossLinks: {
        const circleId = input.params.circleId as string;
        const rows = await listCrossLinksForCircle(circleId);
        return { status: 200, body: rows };
      }

      case API_ROUTES.dissolveCrossLink: {
        const id = input.params.id as string;
        const { reason } = (input.body ?? {}) as { reason?: string };
        if (!reason || !reason.trim()) return { status: 400, body: { error: "reason is required" } };
        const updated = await dissolveCrossLink(id, reason);
        if (!updated) return { status: 404, body: { error: "Cross-link not found" } };
        await dbCtx!.execute(
          `INSERT INTO ${tbl("audit_log")} (company_id, action_type, action_detail) VALUES ($1, 'cross-link-dissolved', $2)`,
          [input.companyId, JSON.stringify({ crossLinkId: id, reason })],
        );
        await publishCrossLinkEvent(updated, "cross_link.dissolved", { reason });
        return { status: 200, body: updated };
      }

      // ── Phase 2 — Concept 3: Role-release lifecycle ──────────────────
      case API_ROUTES.requestRoleRelease: {
        const assignmentId = input.params.id as string;
        const parsed = parseZodInput<RequestReleaseInput>(requestReleaseSchema, input.body, "request role release");
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const result = await requestRoleRelease(input.companyId, assignmentId, parsed.value);
        if (!result.ok) return { status: 409, body: { error: result.error } };
        // Publish to Lead Link's event topic (best-effort)
        try {
          if (mqttCtx) {
            const { eventTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
            const assignmentRow = await dbCtx!.query<{ role_id: string }>(
              `SELECT role_id FROM ${tbl("role_assignments")} WHERE id = $1`,
              [assignmentId],
            );
            if (assignmentRow.length > 0) {
              const roleRow = await dbCtx!.query<{ circle_id: string }>(
                `SELECT circle_id FROM ${tbl("roles")} WHERE id = $1`,
                [assignmentRow[0].role_id],
              );
              if (roleRow.length > 0) {
                const leadAgentId = await findCircleLeadAgentId(roleRow[0].circle_id);
                if (leadAgentId) {
                  await mqttCtx.publish(
                    eventTopic(input.companyId, roleRow[0].circle_id, leadAgentId),
                    {
                      kind: "release_requested",
                      releaseId: result.release.id,
                      roleAssignmentId: assignmentId,
                      releasedByAgentId: parsed.value.releasedByAgentId,
                      reason: parsed.value.reason ?? null,
                      handoffToAgentId: parsed.value.handoffToAgentId ?? null,
                    },
                  );
                }
              }
            }
          }
        } catch (err) {
          console.warn("[holacracy] release_requested publish failed:", err instanceof Error ? err.message : String(err));
        }
        return { status: 201, body: result.release };
      }

      case API_ROUTES.acceptRoleRelease: {
        const releaseId = input.params.id as string;
        const { acceptedByAgentId } = (input.body ?? {}) as { acceptedByAgentId?: string };
        if (!acceptedByAgentId) return { status: 400, body: { error: "acceptedByAgentId is required" } };
        const result = await acceptRoleRelease(input.companyId, releaseId, acceptedByAgentId);
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 200, body: result.release };
      }

      case API_ROUTES.completeRoleRelease: {
        const releaseId = input.params.id as string;
        const result = await completeRoleRelease(input.companyId, releaseId);
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 200, body: result.release };
      }

      case API_ROUTES.listRoleReleases: {
        const { circleId, status } = (input.query ?? {}) as { circleId?: string; status?: string };
        const rows = await listRoleReleases(circleId, status);
        return { status: 200, body: rows };
      }

      // ── Phase 2 — Concept 6: Tactical-pulse + cross-role requests ────
      case API_ROUTES.runTacticalPulse: {
        const circleId = input.params.circleId as string;
        const { cadence } = (input.body ?? {}) as { cadence?: string };
        const pulse = await runTacticalPulse(input.companyId, circleId, cadence ?? "ad_hoc");
        // Broadcast to circle members via MQTT (best-effort)
        try {
          if (mqttCtx) {
            const { eventTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
            const payload = {
              kind: "tactical_pulse",
              tacticalRecordId: pulse.record.id,
              summary: pulse.record.summary,
            };
            await Promise.all(
              pulse.circleAgents.map((aid) =>
                mqttCtx!.publish(eventTopic(input.companyId, circleId, aid), payload).catch((err) => {
                  console.warn("[holacracy] tactical pulse publish failed:", err instanceof Error ? err.message : String(err));
                }),
              ),
            );
          }
        } catch (err) {
          console.warn("[holacracy] tactical pulse fanout failed:", err instanceof Error ? err.message : String(err));
        }
        return { status: 201, body: pulse.record };
      }

      case API_ROUTES.listTacticalRecords: {
        const circleId = input.params.circleId as string;
        const rows = await dbCtx!.query<TacticalRecordRow>(
          `SELECT * FROM ${tbl("tactical_records")} WHERE circle_id = $1 ORDER BY recorded_at DESC LIMIT 100`,
          [circleId],
        );
        return { status: 200, body: rows };
      }

      case API_ROUTES.requestFromRole: {
        const targetRoleId = input.params.roleId as string;
        const parsed = parseZodInput<CrossRoleRequestInput>(crossRoleRequestSchema, input.body, "request from role");
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const result = await requestFromRole(input.companyId, targetRoleId, parsed.value);
        if (!result.ok) return { status: 400, body: { error: result.error } };
        // MQTT v5 request/reply — directly notify the target agent
        try {
          if (mqttCtx && result.targetAgentId && result.targetCircleId) {
            const { requestTopic, replyTopic } = await import("@paperclipai/adapter-a2a-mqtt/server");
            // Find requesting agent's circle (if known) for response routing
            const requestingAgentId = parsed.value.requestingAgentId ?? null;
            let responseTopic: string | undefined;
            if (requestingAgentId) {
              // Resolve the requesting agent's circle (use any role assignment)
              const reqAgentCircle = await dbCtx!.query<{ circle_id: string }>(
                `SELECT r.circle_id FROM ${tbl("role_assignments")} ra
                 JOIN ${tbl("roles")} r ON r.id = ra.role_id
                 WHERE ra.agent_id = $1 LIMIT 1`,
                [requestingAgentId],
              );
              if (reqAgentCircle.length > 0) {
                responseTopic = replyTopic(input.companyId, reqAgentCircle[0].circle_id, requestingAgentId, result.row.id);
              }
            }
            const opts: { responseTopic?: string; correlationData?: Buffer; userProperties?: Record<string, string> } = {
              correlationData: Buffer.from(result.row.id, "utf8"),
              userProperties: {
                kind: parsed.value.kind,
                requestingRoleId: parsed.value.requestingRoleId,
                targetRoleId,
              },
            };
            if (responseTopic) opts.responseTopic = responseTopic;
            await mqttCtx.publish(
              requestTopic(input.companyId, result.targetCircleId, result.targetAgentId),
              {
                kind: "cross_role_request",
                requestId: result.row.id,
                requestingRoleId: parsed.value.requestingRoleId,
                targetRoleId,
                requestKind: parsed.value.kind,
                body: parsed.value.body,
                issueId: result.issueId,
              },
              opts,
            );
          }
        } catch (err) {
          console.warn("[holacracy] cross-role request publish failed:", err instanceof Error ? err.message : String(err));
        }
        return { status: 201, body: result.row };
      }

      case API_ROUTES.acceptCrossRoleRequest: {
        const requestId = input.params.id as string;
        const result = await decideCrossRoleRequest(input.companyId, requestId, "accepted");
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 200, body: result.row };
      }

      case API_ROUTES.declineCrossRoleRequest: {
        const requestId = input.params.id as string;
        const { reason } = (input.body ?? {}) as { reason?: string };
        if (!reason || !reason.trim()) return { status: 400, body: { error: "reason is required" } };
        const result = await decideCrossRoleRequest(input.companyId, requestId, "declined", reason);
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 200, body: result.row };
      }

      // ── Phase 2 — Concept 8: Elections ────────────────────────────────
      case API_ROUTES.requestElection: {
        const circleId = input.params.circleId as string;
        const { targetRoleId, requestedByAgentId } = (input.body ?? {}) as { targetRoleId?: string; requestedByAgentId?: string };
        if (!targetRoleId) return { status: 400, body: { error: "targetRoleId is required" } };
        const created = await requestElection(input.companyId, { circleId, targetRoleId, requestedByAgentId: requestedByAgentId ?? null });
        return { status: 201, body: created };
      }

      case API_ROUTES.runElectionScoring: {
        const electionId = input.params.id as string;
        const result = await runElectionScoring(electionId);
        if (!result.ok) return { status: 400, body: { error: result.error } };
        return { status: 200, body: { electionId, candidates: result.candidates } };
      }

      case API_ROUTES.decideElection: {
        const electionId = input.params.id as string;
        const { decisionAgentId } = (input.body ?? {}) as { decisionAgentId?: string };
        if (!decisionAgentId) return { status: 400, body: { error: "decisionAgentId is required" } };
        const result = await decideElection(electionId, decisionAgentId);
        if (!result.ok) return { status: 409, body: { error: result.error } };
        return { status: 200, body: result.election };
      }

      case API_ROUTES.cancelElection: {
        const electionId = input.params.id as string;
        const updated = await cancelElection(electionId);
        if (!updated) return { status: 404, body: { error: "Election not found" } };
        return { status: 200, body: updated };
      }

      case API_ROUTES.listElections: {
        const circleId = input.params.circleId as string;
        const rows = await dbCtx!.query<ElectionRequestRow>(
          `SELECT * FROM ${tbl("role_election_requests")} WHERE circle_id = $1 ORDER BY created_at DESC`,
          [circleId],
        );
        return { status: 200, body: rows };
      }

      // ── Phase 1.14 — Circle Discussions ────────────────────────────────
      case API_ROUTES.createDiscussion: {
        const body = input.body as {
          circleId?: string;
          topic: string;
          prompt?: string;
          rounds?: number;
          speakerMode?: string;
          initiatedByAgentId?: string;
          initiatedByUserId?: string;
          participantAgentIds?: string[];
          // Phase 1.15h-h1 — SMART fields from API body.
          successCriterion?: string;
          scopeIn?: string[];
          scopeOut?: string[];
          decisionDeadline?: string;
          motivatingTensionId?: string;
          expectedOutputKind?: string;
          // Phase 1.15h-i #2 — Grove pre-flight from API body.
          decisionOwnerAgentId?: string | null;
          consultedAgentIds?: string[];
          ratifierAgentId?: string | null;
          informedAgentIds?: string[];
        };
        const result = await createDiscussion({
          circleId: body.circleId ?? null,
          topic: body.topic,
          prompt: body.prompt,
          rounds: body.rounds,
          speakerMode: body.speakerMode,
          companyId: input.companyId,
          initiatedByAgentId: body.initiatedByAgentId ?? null,
          initiatedByUserId: body.initiatedByUserId ?? null,
          participantAgentIds: body.participantAgentIds,
          successCriterion: body.successCriterion,
          scopeIn: body.scopeIn,
          scopeOut: body.scopeOut,
          decisionDeadline: body.decisionDeadline,
          motivatingTensionId: body.motivatingTensionId,
          expectedOutputKind: body.expectedOutputKind,
          decisionOwnerAgentId: body.decisionOwnerAgentId ?? null,
          consultedAgentIds: body.consultedAgentIds,
          ratifierAgentId: body.ratifierAgentId ?? null,
          informedAgentIds: body.informedAgentIds,
        });
        if (!result.ok) return { status: result.status, body: { error: result.error } };
        return {
          status: 201,
          body: {
            discussionId: result.discussion.id,
            issueIds: result.issueIds,
            contextId: result.discussion.a2a_context_id,
            speakerMode: result.discussion.speaker_mode,
            speakerOrder: result.discussion.speaker_order,
            participantAgentIds: result.discussion.participant_agent_ids,
          },
        };
      }

      case API_ROUTES.getDiscussion: {
        const discussionId = input.params.discussionId as string;
        const row = await loadDiscussion(discussionId);
        if (!row) return { status: 404, body: { error: "Discussion not found" } };
        const turns = await loadDiscussionTurns(discussionId);
        const commitments = await dbCtx!.query<{
          agent_id: string;
          signal: string;
          reason: string | null;
          signaled_at: string;
        }>(
          `SELECT agent_id, signal, reason, signaled_at::text
             FROM public.discussion_commitments WHERE discussion_id = $1
             ORDER BY signaled_at ASC`,
          [discussionId],
        );
        return { status: 200, body: { discussion: row, turns, commitments } };
      }

      case API_ROUTES.concludeDiscussion: {
        const discussionId = input.params.discussionId as string;
        const body = input.body as {
          conclusion?: string;
          conclusionKind?: string | null;
        };
        const result = await concludeDiscussion(
          discussionId,
          body.conclusion ?? "(manually concluded)",
          body.conclusionKind ?? "note",
        );
        if (!result.ok) return { status: result.status, body: { error: result.error } };
        return { status: 200, body: { discussion: result.row } };
      }

      case API_ROUTES.listCircleDiscussions: {
        const circleId = input.params.circleId as string;
        const rows = await dbCtx!.query<CircleDiscussionRow>(
          `SELECT * FROM public.circle_discussions
            WHERE circle_id = $1
            ORDER BY started_at DESC
            LIMIT 50`,
          [circleId],
        );
        return { status: 200, body: rows };
      }

      default:
        return { status: 404, body: { error: "Unknown route" } };
    }
    } catch (err) {
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  },

});

runWorker(plugin, import.meta.url);

export default plugin;
