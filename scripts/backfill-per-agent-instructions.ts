#!/usr/bin/env tsx
/**
 * Per-agent AGENTS.md backfill.
 *
 * Reads role-shape templates from server/src/onboarding-assets/{lead-link,facilitator,secretary,rep-link,specialist}/AGENTS.md,
 * interpolates per-agent metadata (name, circles, role assignments, sibling agents),
 * and materializes the managed instructions bundle for every agent in the company.
 *
 * Run:   npx tsx scripts/backfill-per-agent-instructions.ts --company <companyId>
 *        npx tsx scripts/backfill-per-agent-instructions.ts --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, companies, createDb, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { agentInstructionsService } from "../server/src/services/agent-instructions.js";

type RoleShape = "lead_link" | "facilitator" | "secretary" | "rep_link" | "specialist";

const ROLE_TEMPLATE_DIRS: Record<RoleShape, string> = {
  lead_link: "lead-link",
  facilitator: "facilitator",
  secretary: "secretary",
  rep_link: "rep-link",
  specialist: "specialist",
};

const ROLE_TITLE: Record<RoleShape, string> = {
  lead_link: "Lead Link",
  facilitator: "Facilitator",
  secretary: "Secretary",
  rep_link: "Rep Link",
  specialist: "Specialist",
};

type Assignment = {
  roleId: string;
  roleName: string;
  roleType: string;
  roleAccountabilities: unknown;
  circleId: string;
  circleName: string;
  circlePurpose: string | null;
  parentCircleId: string | null;
};

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  title: string | null;
  adapterConfig: unknown;
};

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function classifyRoleShape(roleName: string): RoleShape {
  const lower = roleName.toLowerCase();
  if (lower.includes("lead link") || lower === "circle lead" || lower.endsWith(" lead link")) return "lead_link";
  if (lower.includes("facilitator")) return "facilitator";
  if (lower.includes("secretary")) return "secretary";
  if (lower.includes("rep link") || lower === "circle rep" || lower.endsWith(" rep link")) return "rep_link";
  return "specialist";
}

function primaryRoleShape(assignments: Assignment[]): RoleShape {
  const counts: Record<RoleShape, number> = {
    lead_link: 0,
    facilitator: 0,
    secretary: 0,
    rep_link: 0,
    specialist: 0,
  };
  for (const a of assignments) counts[classifyRoleShape(a.roleName)]++;
  // Order matters when ties — Lead Link wins over Facilitator wins over Secretary etc.
  // because Lead Link is the highest-authority canonical role-shape.
  const priority: RoleShape[] = ["lead_link", "facilitator", "secretary", "rep_link", "specialist"];
  let best: RoleShape = "specialist";
  let bestScore = -1;
  for (const shape of priority) {
    if (counts[shape] > bestScore) {
      best = shape;
      bestScore = counts[shape];
    }
  }
  return best;
}

function formatAccountabilities(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const lines: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      lines.push(`    - ${entry}`);
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : null;
      const metric = typeof obj.metric === "string" ? obj.metric : null;
      if (name && metric) lines.push(`    - **${name}** — ${metric}`);
      else if (name) lines.push(`    - **${name}**`);
    }
  }
  return lines.join("\n");
}

function buildCirclesList(assignments: Assignment[]): string {
  if (assignments.length === 0) return "_(no role assignments yet)_";
  const byCircle = new Map<string, { circleName: string; circlePurpose: string | null; roles: Assignment[] }>();
  for (const a of assignments) {
    const bucket = byCircle.get(a.circleId);
    if (bucket) {
      bucket.roles.push(a);
    } else {
      byCircle.set(a.circleId, { circleName: a.circleName, circlePurpose: a.circlePurpose, roles: [a] });
    }
  }
  const lines: string[] = [];
  for (const [circleId, bucket] of byCircle) {
    lines.push(`- **${bucket.circleName}** (\`${circleId}\`)`);
    if (bucket.circlePurpose) lines.push(`  - Purpose: ${bucket.circlePurpose}`);
    for (const role of bucket.roles) {
      lines.push(`  - Role: **${role.roleName}** (\`${role.roleId}\`)`);
      if (role.roleAccountabilities) {
        const formatted = formatAccountabilities(role.roleAccountabilities);
        if (formatted) lines.push(`    - Accountabilities:\n${formatted}`);
      }
    }
  }
  return lines.join("\n");
}

function buildSiblingsList(
  selfAgentId: string,
  selfAssignments: Assignment[],
  allAssignments: Map<string, Assignment[]>,
  agentNameById: Map<string, string>,
): string {
  const selfCircleIds = new Set(selfAssignments.map((a) => a.circleId));
  if (selfCircleIds.size === 0) return "_(no neighbouring agents yet — your circle is empty)_";

  type Sibling = { agentId: string; agentName: string; roleName: string; circleName: string; circleId: string };
  const siblings: Sibling[] = [];
  for (const [agentId, agentAssignments] of allAssignments) {
    if (agentId === selfAgentId) continue;
    for (const a of agentAssignments) {
      if (selfCircleIds.has(a.circleId)) {
        siblings.push({
          agentId,
          agentName: agentNameById.get(agentId) ?? agentId,
          roleName: a.roleName,
          circleName: a.circleName,
          circleId: a.circleId,
        });
      }
    }
  }
  if (siblings.length === 0) return "_(no siblings yet in your circle(s))_";

  // Group by circle for readability.
  const byCircle = new Map<string, { circleName: string; entries: Sibling[] }>();
  for (const s of siblings) {
    const bucket = byCircle.get(s.circleId);
    if (bucket) bucket.entries.push(s);
    else byCircle.set(s.circleId, { circleName: s.circleName, entries: [s] });
  }
  const lines: string[] = [];
  for (const [, bucket] of byCircle) {
    lines.push(`### ${bucket.circleName}`);
    lines.push("");
    lines.push("| Agent | Role | Agent ID |");
    lines.push("|---|---|---|");
    for (const entry of bucket.entries) {
      lines.push(`| ${entry.agentName} | ${entry.roleName} | \`${entry.agentId}\` |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function loadTemplate(scriptDir: string, shape: RoleShape): Promise<string> {
  const templatePath = path.resolve(
    scriptDir,
    "..",
    "server",
    "src",
    "onboarding-assets",
    ROLE_TEMPLATE_DIRS[shape],
    "AGENTS.md",
  );
  return fs.readFile(templatePath, "utf8");
}

function interpolate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, val] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, val);
  }
  return out;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const instructions = agentInstructionsService();
  const companyHandleOrId = parseFlag("--company");
  const dryRun = hasFlag("--dry-run");

  const companyRows = await (async () => {
    if (!companyHandleOrId) return db.select({ id: companies.id, name: companies.name, prefix: companies.issuePrefix }).from(companies);
    return db.execute<{ id: string; name: string; prefix: string }>(sql`
      SELECT id, name, issue_prefix AS prefix FROM companies
      WHERE id::text = ${companyHandleOrId} OR issue_prefix = ${companyHandleOrId} OR name = ${companyHandleOrId}
    `).then((res) => (res as unknown as Array<{ id: string; name: string; prefix: string }>));
  })();

  if (companyRows.length === 0) {
    console.log(`No companies found${companyHandleOrId ? ` for ${companyHandleOrId}` : ""}; nothing to backfill.`);
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const templates: Record<RoleShape, string> = {
    lead_link: await loadTemplate(scriptDir, "lead_link"),
    facilitator: await loadTemplate(scriptDir, "facilitator"),
    secretary: await loadTemplate(scriptDir, "secretary"),
    rep_link: await loadTemplate(scriptDir, "rep_link"),
    specialist: await loadTemplate(scriptDir, "specialist"),
  };

  for (const company of companyRows) {
    console.log(`\n=== Company: ${company.name} (${company.prefix}) [${company.id}] ===`);

    const agentRows = (await db.select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      title: agents.title,
      adapterConfig: agents.adapterConfig,
    }).from(agents).where(sql`${agents.companyId} = ${company.id}`)) as AgentRow[];

    if (agentRows.length === 0) {
      console.log("  No agents.");
      continue;
    }

    // Discover the holacracy plugin schema (suffix is per-company-deterministic).
    const schemaRows = (await db.execute<{ schema_name: string }>(sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'plugin_holacracy_%'
      ORDER BY schema_name LIMIT 1
    `)) as unknown as Array<{ schema_name: string }>;
    const holacracySchema = schemaRows[0]?.schema_name;
    if (!holacracySchema) {
      console.log("  Holacracy plugin schema not found; skipping.");
      continue;
    }

    const allRows = (await db.execute(sql.raw(`
      SELECT
        ra.agent_id,
        r.id AS role_id,
        r.name AS role_name,
        r.role_type,
        r.accountabilities AS role_accountabilities,
        c.id AS circle_id,
        c.name AS circle_name,
        c.purpose AS circle_purpose,
        c.parent_circle_id
      FROM ${holacracySchema}.role_assignments ra
      JOIN ${holacracySchema}.roles r ON r.id = ra.role_id
      JOIN ${holacracySchema}.circles c ON c.id = r.circle_id
      WHERE c.company_id = '${company.id}'
      ORDER BY ra.agent_id, c.name, r.name
    `))) as unknown as Array<{
      agent_id: string; role_id: string; role_name: string; role_type: string;
      role_accountabilities: unknown; circle_id: string; circle_name: string;
      circle_purpose: string | null; parent_circle_id: string | null;
    }>;

    const assignmentsByAgent = new Map<string, Assignment[]>();
    for (const row of allRows) {
      const a: Assignment = {
        roleId: row.role_id,
        roleName: row.role_name,
        roleType: row.role_type,
        roleAccountabilities: row.role_accountabilities,
        circleId: row.circle_id,
        circleName: row.circle_name,
        circlePurpose: row.circle_purpose,
        parentCircleId: row.parent_circle_id,
      };
      const existing = assignmentsByAgent.get(row.agent_id);
      if (existing) existing.push(a);
      else assignmentsByAgent.set(row.agent_id, [a]);
    }

    const agentNameById = new Map<string, string>(agentRows.map((a) => [a.id, a.name]));

    for (const agent of agentRows) {
      const assignments = assignmentsByAgent.get(agent.id) ?? [];
      const shape = primaryRoleShape(assignments);
      const template = templates[shape];

      const roleTitles = (() => {
        if (assignments.length === 0) return ROLE_TITLE[shape];
        const titles = [...new Set(assignments.map((a) => a.roleName))];
        return titles.join(" / ");
      })();

      const content = interpolate(template, {
        AGENT_NAME: agent.name,
        COMPANY_NAME: company.name,
        ROLE_TITLES: roleTitles,
        CIRCLES_LIST: buildCirclesList(assignments),
        SIBLINGS_LIST: buildSiblingsList(agent.id, assignments, assignmentsByAgent, agentNameById),
      });

      console.log(`  - ${agent.name.padEnd(28)} → ${ROLE_TITLE[shape].padEnd(11)} (${assignments.length} role assignment${assignments.length === 1 ? "" : "s"}, ${content.length} chars)`);

      if (dryRun) {
        const previewDir = path.resolve(scriptDir, "..", ".tmp", "agents-md-preview");
        await fs.mkdir(previewDir, { recursive: true });
        const previewPath = path.resolve(previewDir, `${agent.name.replace(/[^\w-]+/g, "_")}.md`);
        await fs.writeFile(previewPath, content, "utf8");
        continue;
      }

      const { adapterConfig } = await instructions.materializeManagedBundle(
        { id: agent.id, companyId: agent.companyId, name: agent.name, adapterConfig: agent.adapterConfig ?? {} },
        { "AGENTS.md": content },
        { clearLegacyPromptTemplate: true, entryFile: "AGENTS.md" },
      );

      await db.update(agents).set({ adapterConfig, updatedAt: new Date() }).where(sql`${agents.id} = ${agent.id}`);
    }
  }

  console.log(dryRun ? "\nDry run complete — preview files in .tmp/agents-md-preview/" : "\nBackfill complete.");
}

void main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Backfill failed:", msg);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
