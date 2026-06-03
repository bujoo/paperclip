/**
 * @fileoverview Vector-indexed skill discovery (Phase 1.19 T3).
 *
 * Embeds SKILL.md content from `company_skills` rows and exposes a
 * semantic-search query that returns the closest matching skill chunks for
 * a free-text task description. Embeddings are cached in
 * `company_skills.metadata.embeddings_v1` as
 * `Array<{ chunkText, chunkIndex, vector: number[] }>` so re-indexing is
 * idempotent and a future schema change can bump the version key.
 *
 * Chunking: split each markdown doc on h2/h3 headings; fall back to the
 * whole document if no headings are present. Chunks larger than
 * MAX_CHUNK_CHARS are truncated (we keep the head — h2/h3 sections are
 * typically self-describing in their first paragraph).
 *
 * We deliberately do NOT introduce pgvector. The expected catalog size
 * (~50 skills × ~10 chunks each) makes in-memory cosine similarity cheap.
 *
 * @module server/services/skill-index
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import { embedText, cosineSimilarity } from "@paperclipai/adapter-bedrock-gateway/server";
import { logger } from "../middleware/logger.js";

const EMBEDDINGS_METADATA_KEY = "embeddings_v1" as const;
const MAX_CHUNK_CHARS = 6_000;
const MAX_QUERY_CACHE_ENTRIES = 32;

export interface SkillEmbeddingChunk {
  chunkText: string;
  chunkIndex: number;
  vector: number[];
}

export interface SemanticSkillSearchResult {
  skillSlug: string;
  skillId: string;
  skillName: string;
  chunkText: string;
  chunkIndex: number;
  /** Distance in [0, 2]; lower is better. distance = 1 - cosineSimilarity. */
  semanticDistance: number;
}

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  markdown: string;
  metadata: Record<string, unknown> | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split a markdown document into chunks at h2 (`## `) or h3 (`### `)
 * boundaries. Headings stay with the section that follows them. If no
 * h2/h3 headings are present, the whole (trimmed) doc is returned as one
 * chunk. Empty / whitespace-only chunks are dropped.
 */
export function chunkSkillMarkdown(markdown: string): string[] {
  const trimmed = (markdown ?? "").trim();
  if (!trimmed) return [];

  // Strip leading YAML frontmatter — we don't want to embed it.
  let body = trimmed;
  if (body.startsWith("---\n")) {
    const closing = body.indexOf("\n---\n", 4);
    if (closing > 0) body = body.slice(closing + 5).trim();
  }
  if (!body) return [];

  const lines = body.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const piece = current.join("\n").trim();
    if (piece.length > 0) {
      chunks.push(piece.length > MAX_CHUNK_CHARS ? piece.slice(0, MAX_CHUNK_CHARS) : piece);
    }
    current = [];
  };

  let hasHeadings = false;
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      hasHeadings = true;
      flush();
    }
    current.push(line);
  }
  flush();

  if (!hasHeadings) {
    return [body.length > MAX_CHUNK_CHARS ? body.slice(0, MAX_CHUNK_CHARS) : body];
  }
  return chunks;
}

function readCachedEmbeddings(metadata: Record<string, unknown> | null): SkillEmbeddingChunk[] | null {
  if (!isPlainRecord(metadata)) return null;
  const raw = metadata[EMBEDDINGS_METADATA_KEY];
  if (!Array.isArray(raw)) return null;
  const out: SkillEmbeddingChunk[] = [];
  for (const entry of raw) {
    if (!isPlainRecord(entry)) continue;
    const chunkText = typeof entry.chunkText === "string" ? entry.chunkText : null;
    const chunkIndex = typeof entry.chunkIndex === "number" ? entry.chunkIndex : null;
    const vector = Array.isArray(entry.vector) ? entry.vector.filter((v): v is number => typeof v === "number") : null;
    if (chunkText === null || chunkIndex === null || !vector || vector.length === 0) continue;
    out.push({ chunkText, chunkIndex, vector });
  }
  return out.length > 0 ? out : null;
}

async function buildEmbeddingsForSkill(markdown: string): Promise<SkillEmbeddingChunk[]> {
  const chunks = chunkSkillMarkdown(markdown);
  const out: SkillEmbeddingChunk[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunkText = chunks[i]!;
    try {
      const vector = await embedText(chunkText, { inputType: "search_document" });
      out.push({ chunkText, chunkIndex: i, vector });
    } catch (err) {
      logger.warn(
        { err, chunkIndex: i, chunkChars: chunkText.length },
        "skill-index: embedText failed for chunk; skipping",
      );
    }
  }
  return out;
}

async function persistEmbeddings(
  db: Db,
  skillId: string,
  existingMetadata: Record<string, unknown> | null,
  embeddings: SkillEmbeddingChunk[],
): Promise<void> {
  const nextMetadata: Record<string, unknown> = {
    ...(isPlainRecord(existingMetadata) ? existingMetadata : {}),
    [EMBEDDINGS_METADATA_KEY]: embeddings,
  };
  await db
    .update(companySkills)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(eq(companySkills.id, skillId));
}

async function loadSkillRows(db: Db, companyId: string): Promise<SkillRow[]> {
  const rows = await db
    .select({
      id: companySkills.id,
      slug: companySkills.slug,
      name: companySkills.name,
      markdown: companySkills.markdown,
      metadata: companySkills.metadata,
    })
    .from(companySkills)
    .where(eq(companySkills.companyId, companyId));
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    markdown: row.markdown,
    metadata: isPlainRecord(row.metadata) ? (row.metadata as Record<string, unknown>) : null,
  }));
}

async function loadSkillRowBySlug(
  db: Db,
  companyId: string,
  skillSlug: string,
): Promise<SkillRow | null> {
  const [row] = await db
    .select({
      id: companySkills.id,
      slug: companySkills.slug,
      name: companySkills.name,
      markdown: companySkills.markdown,
      metadata: companySkills.metadata,
    })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), eq(companySkills.slug, skillSlug)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    markdown: row.markdown,
    metadata: isPlainRecord(row.metadata) ? (row.metadata as Record<string, unknown>) : null,
  };
}

/**
 * Re-embed a single skill (called when its SKILL.md content changes).
 * Best-effort: returns the persisted chunk count and swallows + logs
 * errors so a Bedrock outage never blocks skill edits.
 */
export async function indexSkill(
  db: Db,
  companyId: string,
  skillSlug: string,
): Promise<{ chunkCount: number; reason?: string }> {
  try {
    const skill = await loadSkillRowBySlug(db, companyId, skillSlug);
    if (!skill) return { chunkCount: 0, reason: "skill not found" };
    const embeddings = await buildEmbeddingsForSkill(skill.markdown);
    if (embeddings.length === 0) return { chunkCount: 0, reason: "no chunks" };
    await persistEmbeddings(db, skill.id, skill.metadata, embeddings);
    return { chunkCount: embeddings.length };
  } catch (err) {
    logger.warn({ err, companyId, skillSlug }, "skill-index: indexSkill failed (best-effort)");
    return { chunkCount: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ensure every skill row in the company has cached embeddings. Skills
 * with content changes will appear stale (cached chunk text != current
 * head chunk); we re-embed those. Best-effort per-skill.
 */
async function ensureCompanyEmbeddingsCurrent(db: Db, companyId: string): Promise<SkillRow[]> {
  const rows = await loadSkillRows(db, companyId);
  for (const skill of rows) {
    const cached = readCachedEmbeddings(skill.metadata);
    const chunks = chunkSkillMarkdown(skill.markdown);
    const isStale =
      !cached
      || cached.length !== chunks.length
      || (chunks.length > 0 && cached[0]!.chunkText !== chunks[0]);
    if (!isStale) continue;
    try {
      const embeddings = await buildEmbeddingsForSkill(skill.markdown);
      if (embeddings.length === 0) continue;
      await persistEmbeddings(db, skill.id, skill.metadata, embeddings);
      // Refresh the in-memory copy so the search below uses it.
      skill.metadata = {
        ...(skill.metadata ?? {}),
        [EMBEDDINGS_METADATA_KEY]: embeddings,
      };
    } catch (err) {
      logger.warn(
        { err, companyId, skillId: skill.id, skillSlug: skill.slug },
        "skill-index: ensureCompanyEmbeddingsCurrent: per-skill index failed (best-effort)",
      );
    }
  }
  return rows;
}

// ── In-memory LRU for query-vector caching ────────────────────────────────
// Same query string from agents in quick succession is common (an agent
// retries / re-plans). Cache the last N query embeddings.
const queryVectorCache = new Map<string, number[]>();

async function embedQuery(query: string): Promise<number[]> {
  const cached = queryVectorCache.get(query);
  if (cached) {
    // Move-to-end for LRU semantics.
    queryVectorCache.delete(query);
    queryVectorCache.set(query, cached);
    return cached;
  }
  const vector = await embedText(query, { inputType: "search_query" });
  queryVectorCache.set(query, vector);
  if (queryVectorCache.size > MAX_QUERY_CACHE_ENTRIES) {
    const oldestKey = queryVectorCache.keys().next().value;
    if (oldestKey !== undefined) queryVectorCache.delete(oldestKey);
  }
  return vector;
}

/**
 * Find the top-K skill chunks across a company that semantically match
 * `queryText`. Ensures embeddings are current (re-indexes stale rows
 * on the fly), then computes cosine similarity in memory.
 */
export async function semanticSkillSearch(
  db: Db,
  companyId: string,
  queryText: string,
  topK = 5,
): Promise<SemanticSkillSearchResult[]> {
  const trimmedQuery = queryText.trim();
  if (!trimmedQuery) return [];

  const skills = await ensureCompanyEmbeddingsCurrent(db, companyId);
  if (skills.length === 0) return [];

  let queryVector: number[];
  try {
    queryVector = await embedQuery(trimmedQuery);
  } catch (err) {
    logger.warn({ err, companyId }, "skill-index: query embedding failed");
    return [];
  }

  const scored: SemanticSkillSearchResult[] = [];
  for (const skill of skills) {
    const cached = readCachedEmbeddings(skill.metadata);
    if (!cached) continue;
    for (const chunk of cached) {
      if (chunk.vector.length !== queryVector.length) continue;
      const sim = cosineSimilarity(queryVector, chunk.vector);
      scored.push({
        skillId: skill.id,
        skillSlug: skill.slug,
        skillName: skill.name,
        chunkText: chunk.chunkText,
        chunkIndex: chunk.chunkIndex,
        semanticDistance: 1 - sim,
      });
    }
  }

  scored.sort((a, b) => a.semanticDistance - b.semanticDistance);
  return scored.slice(0, Math.max(1, topK));
}

export interface CandidateAgent {
  agentId: string;
  agentName: string | null;
  /** Aggregate success rate across all trusters for this skill slug. */
  trustScore: number | null;
  successfulExchanges: number;
  failedExchanges: number;
}

/**
 * Best-effort lookup: which agents in the company hold a role whose
 * accountabilities mention the given skill slug (case-insensitive
 * substring match on the accountability `name`). If no agents match
 * via accountability, returns the empty list — callers may fall back
 * to "any agent in the company".
 *
 * Also aggregates trust scores from `agent_trust_signals` so the caller
 * can rank candidates. Trust score = successful / (successful + failed),
 * null if no signals exist yet.
 *
 * This is a T3 stub — T4 will replace it with a proper helper.
 */
export async function findCandidateAgentsForSkill(
  db: Db,
  companyId: string,
  skillSlug: string,
): Promise<CandidateAgent[]> {
  const normalizedSlug = skillSlug.trim().toLowerCase();
  if (!normalizedSlug) return [];

  interface AgentRow extends Record<string, unknown> {
    agentId: string;
    agentName: string | null;
  }
  let agentRows: AgentRow[] = [];
  try {
    const result = await db.execute<AgentRow>(sql`
      SELECT DISTINCT
        a.id::text AS "agentId",
        a.name     AS "agentName"
      FROM public.agents a
      WHERE a.company_id = ${companyId}::uuid
        AND a.status NOT IN ('archived', 'terminated')
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(a.accountabilities, '[]'::jsonb)) AS acc
          WHERE LOWER(COALESCE(acc->>'name', '')) LIKE ${"%" + normalizedSlug + "%"}
        )
      LIMIT 50
    `);
    const list = Array.isArray(result) ? result : (result as unknown as { rows?: AgentRow[] }).rows ?? [];
    agentRows = list as AgentRow[];
  } catch (err) {
    logger.warn({ err, companyId, skillSlug }, "skill-index: candidate-agents lookup failed");
    return [];
  }

  if (agentRows.length === 0) return [];

  interface TrustRow extends Record<string, unknown> {
    trustedAgentId: string;
    successfulExchanges: number;
    failedExchanges: number;
  }
  let trustRows: TrustRow[] = [];
  try {
    const result = await db.execute<TrustRow>(sql`
      SELECT
        t.trusted_agent_id::text                 AS "trustedAgentId",
        SUM(t.successful_exchanges)::int         AS "successfulExchanges",
        SUM(t.failed_exchanges)::int             AS "failedExchanges"
      FROM public.agent_trust_signals t
      WHERE t.skill_slug = ${normalizedSlug}
      GROUP BY t.trusted_agent_id
    `);
    const list = Array.isArray(result) ? result : (result as unknown as { rows?: TrustRow[] }).rows ?? [];
    trustRows = list as TrustRow[];
  } catch (err) {
    logger.debug({ err, skillSlug }, "skill-index: trust-signal aggregate failed (best-effort)");
  }

  const trustByAgent = new Map<string, { successful: number; failed: number }>();
  for (const row of trustRows) {
    trustByAgent.set(row.trustedAgentId, {
      successful: Number(row.successfulExchanges ?? 0),
      failed: Number(row.failedExchanges ?? 0),
    });
  }

  return agentRows.map((row) => {
    const trust = trustByAgent.get(row.agentId);
    const total = trust ? trust.successful + trust.failed : 0;
    return {
      agentId: row.agentId,
      agentName: row.agentName,
      trustScore: total > 0 && trust ? trust.successful / total : null,
      successfulExchanges: trust?.successful ?? 0,
      failedExchanges: trust?.failed ?? 0,
    };
  });
}
