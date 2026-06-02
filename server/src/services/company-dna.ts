/**
 * Company DNA service — Phase 1.9.
 *
 * Exports:
 *  - `getCompanyDna(db, companyId)` — assembles the versioned envelope
 *    projected from companies + policies + agreements + heuristic_weights +
 *    domain_registry + anchor circle.
 *  - `updateCompanyDna(db, companyId, partial, actorId, reason?)` — writes
 *    the columns on `companies`, increments `dna_generation`, stamps
 *    `dna_mutated_at` / `dna_mutated_reason`, and logs a
 *    `company_dna_mutated` activity entry that the bridge picks up to
 *    republish the retained MQTT envelope.
 *
 * Lives in its own file (not `companies.ts`) to keep merge conflicts with
 * Round 1 small. Re-export from `companies.ts` if you want a single import
 * point.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

// ---------------------------------------------------------------------------
// Envelope schema
// ---------------------------------------------------------------------------

export type DnaPolicy = {
  id: string;
  title: string;
  scope: "company" | "circle";
  text: string | null;
};

export type DnaAgreement = {
  id: string;
  parties: Array<Record<string, unknown>>;
  condition: string | null;
  commitment: string | null;
  expiresAt: string | null;
};

export interface DnaEnvelope {
  dna_version: "1";
  company_id: string;
  generation: number;
  mutated_at: string | null;
  mutated_reason: string | null;
  identity: {
    name: string;
    mission_statement: string | null;
    values: string[];
  };
  constitution: {
    governance: "holacracy-v5";
    transport: "a2a-mqtt";
    text: string | null;
    doctrine_ref: string;
  };
  domain_registry: {
    domains: Array<Record<string, unknown>>;
    conflicts: Array<Record<string, unknown>>;
  };
  policies: DnaPolicy[];
  active_agreements: DnaAgreement[];
  heuristic_weights_version: number | null;
  anchor_circle_id: string | null;
}

const DOCTRINE_REF = "docs/specs/holacracy-vs-hierarchy-ai-agents.md";

// ---------------------------------------------------------------------------
// Loaders (best-effort: every cross-table read tolerates absent schemas)
// ---------------------------------------------------------------------------

interface CompanyRow extends Record<string, unknown> {
  id: string;
  name: string;
  missionStatement: string | null;
  values: string[];
  constitution: string | null;
  dnaGeneration: number;
  dnaMutatedAt: string | null;
  dnaMutatedReason: string | null;
}

async function loadCompanyRow(db: Db, companyId: string): Promise<CompanyRow | null> {
  try {
    const rows = await db.execute<CompanyRow>(sql`
      SELECT
        id::text AS "id",
        name,
        mission_statement AS "missionStatement",
        COALESCE(values, '[]'::jsonb) AS "values",
        constitution,
        dna_generation AS "dnaGeneration",
        dna_mutated_at::text AS "dnaMutatedAt",
        dna_mutated_reason AS "dnaMutatedReason"
      FROM public.companies
      WHERE id = ${companyId}::uuid
      LIMIT 1
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: CompanyRow[] }).rows ?? [];
    return list[0] ?? null;
  } catch {
    return null;
  }
}

async function loadCompanyPolicies(db: Db, companyId: string): Promise<DnaPolicy[]> {
  // Top-level / company-scope policies live in plugin-holacracy; filter to
  // policies whose circle is the anchor (root) circle for the company, OR
  // policies tagged as company-scope. We approximate by emitting all policies
  // belonging to circles with no parent (root). Empty when schema absent.
  try {
    type Row = DnaPolicy & Record<string, unknown>;
    const rows = await db.execute<Row>(sql`
      SELECT p.id::text AS "id",
             p.title AS "title",
             'company'::text AS "scope",
             p.description AS "text"
      FROM plugin_holacracy_c5049b5dfe.policies p
      JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = p.circle_id
      WHERE c.company_id = ${companyId}::uuid AND c.parent_circle_id IS NULL
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((r): DnaPolicy => ({ id: r.id, title: r.title, scope: r.scope, text: r.text }));
  } catch {
    return [];
  }
}

async function loadActiveAgreements(db: Db, companyId: string): Promise<DnaAgreement[]> {
  try {
    type Row = {
      id: string;
      partiesRaw: unknown;
      condition: string | null;
      commitment: string | null;
      expiresAt: string | null;
    } & Record<string, unknown>;
    const rows = await db.execute<Row>(sql`
      SELECT a.id::text AS "id",
             COALESCE(a.parties, '[]'::jsonb) AS "partiesRaw",
             a.condition AS "condition",
             a.commitment AS "commitment",
             a.expires_at::text AS "expiresAt"
      FROM plugin_holacracy_c5049b5dfe.agreements a
      WHERE a.company_id = ${companyId}::uuid AND a.status = 'active'
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Row[] }).rows ?? [];
    return list.map((row): DnaAgreement => ({
      id: row.id,
      parties: Array.isArray(row.partiesRaw)
        ? (row.partiesRaw as Array<Record<string, unknown>>)
        : [],
      condition: row.condition,
      commitment: row.commitment,
      expiresAt: row.expiresAt,
    }));
  } catch {
    return [];
  }
}

async function loadDomainRegistry(db: Db, companyId: string): Promise<{
  domains: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
}> {
  try {
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT d.* FROM plugin_holacracy_c5049b5dfe.domain_registry d
      WHERE d.company_id = ${companyId}::uuid
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return { domains: list, conflicts: [] };
  } catch {
    return { domains: [], conflicts: [] };
  }
}

async function loadHeuristicWeightsVersion(db: Db, companyId: string): Promise<number | null> {
  try {
    const rows = await db.execute<{ version: number }>(sql`
      SELECT MAX(version)::int AS "version"
      FROM plugin_holacracy_c5049b5dfe.heuristic_weights
      WHERE company_id = ${companyId}::uuid
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<{ version: number }> }).rows ?? [];
    return list[0]?.version ?? null;
  } catch {
    return null;
  }
}

async function loadAnchorCircleId(db: Db, companyId: string): Promise<string | null> {
  try {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id::text AS "id"
      FROM plugin_holacracy_c5049b5dfe.circles
      WHERE company_id = ${companyId}::uuid AND parent_id IS NULL
      LIMIT 1
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<{ id: string }> }).rows ?? [];
    return list[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the DNA envelope for a single company. Returns `null` when the
 * company doesn't exist. All cross-schema reads are best-effort — when the
 * plugin-holacracy schema isn't installed, the returned envelope has empty
 * `policies`, `active_agreements`, and `domain_registry`.
 */
export async function getCompanyDna(db: Db, companyId: string): Promise<DnaEnvelope | null> {
  const company = await loadCompanyRow(db, companyId);
  if (!company) return null;
  const [policies, agreements, domainRegistry, heuristicWeightsVersion, anchorCircleId] =
    await Promise.all([
      loadCompanyPolicies(db, companyId),
      loadActiveAgreements(db, companyId),
      loadDomainRegistry(db, companyId),
      loadHeuristicWeightsVersion(db, companyId),
      loadAnchorCircleId(db, companyId),
    ]);

  const envelope: DnaEnvelope = {
    dna_version: "1",
    company_id: company.id,
    generation: company.dnaGeneration,
    mutated_at: company.dnaMutatedAt,
    mutated_reason: company.dnaMutatedReason,
    identity: {
      name: company.name,
      mission_statement: company.missionStatement,
      values: Array.isArray(company.values) ? company.values : [],
    },
    constitution: {
      governance: "holacracy-v5",
      transport: "a2a-mqtt",
      text: company.constitution,
      doctrine_ref: DOCTRINE_REF,
    },
    domain_registry: domainRegistry,
    policies,
    active_agreements: agreements,
    heuristic_weights_version: heuristicWeightsVersion,
    anchor_circle_id: anchorCircleId,
  };
  return envelope;
}

export interface UpdateCompanyDnaPartial {
  missionStatement?: string | null;
  values?: string[];
  constitution?: string | null;
}

/**
 * Mutate the company DNA envelope (mission/values/constitution). Bumps
 * `dna_generation`, stamps the reason, and logs a `company_dna_mutated`
 * activity entry. The MQTT bridge picks up the event and re-projects the
 * retained DNA topic.
 */
export async function updateCompanyDna(
  db: Db,
  companyId: string,
  partial: UpdateCompanyDnaPartial,
  actor: { type: "agent" | "user" | "system" | "plugin"; id: string },
  reason?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (partial.missionStatement !== undefined) {
      await tx.execute(sql`
        UPDATE public.companies
        SET mission_statement = ${partial.missionStatement}, updated_at = NOW()
        WHERE id = ${companyId}::uuid
      `);
    }
    if (partial.values !== undefined) {
      await tx.execute(sql`
        UPDATE public.companies
        SET values = ${JSON.stringify(partial.values)}::jsonb, updated_at = NOW()
        WHERE id = ${companyId}::uuid
      `);
    }
    if (partial.constitution !== undefined) {
      await tx.execute(sql`
        UPDATE public.companies
        SET constitution = ${partial.constitution}, updated_at = NOW()
        WHERE id = ${companyId}::uuid
      `);
    }
    await tx.execute(sql`
      UPDATE public.companies
      SET dna_generation = dna_generation + 1,
          dna_mutated_at = NOW(),
          dna_mutated_reason = ${reason ?? null}
      WHERE id = ${companyId}::uuid
    `);
  });

  await logActivity(db, {
    companyId,
    actorType: actor.type,
    actorId: actor.id,
    action: "company_dna_mutated",
    entityType: "company",
    entityId: companyId,
    details: {
      reason: reason ?? null,
      fields: Object.keys(partial),
    },
  });
}
