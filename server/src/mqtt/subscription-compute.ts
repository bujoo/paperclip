/**
 * Shared topic-filter computation for the 6-dimensional A2A addressing model
 * (Phase 1.10). Used by both the host-singleton `agent-runtime-bridge.ts`
 * (legacy + hybrid mode) and the per-agent client manager (Phase 1.11). One
 * canonical implementation prevents the two paths from drifting apart.
 *
 * The six dimensions:
 *   1. Personal direct    paperclip/v1/request/{c}/{cir}/{a}
 *   2. Circle broadcast   paperclip/v1/event/{c}/{cir}/+
 *   3. Role pool          $share/paperclip-role/paperclip/v1/role/{c}/{cir}/{role}
 *   4. Role broadcast     paperclip/v1/role/{c}/{cir}/{role}/broadcast
 *   5. Skill pool         $share/paperclip-skill-{slug}/paperclip/v1/skill/{c}/{slug}
 *   6. Skill broadcast    paperclip/v1/skill/{c}/{slug}/broadcast
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  requestTopic,
  eventCircleWildcard,
  rolePoolTopic,
  roleBroadcastTopic,
  skillPoolTopic,
  skillBroadcastTopic,
  sharedSubGroup,
  slugify,
} from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";

export interface AgentSlot {
  companyId: string;
  circleId: string;
  agentId: string;
}

export interface DesiredSubscription {
  filter: string;
  /** Slot used to tag inbound messages (companyId, circleId, agentId). */
  slot: AgentSlot;
}

interface AgentSlotRow extends Record<string, unknown> {
  companyId: string;
  circleId: string;
  agentId: string;
  roleId: string;
}

interface AgentSkillRow extends Record<string, unknown> {
  companyId: string;
  agentId: string;
  accountabilities: Array<Record<string, unknown>> | null;
}

async function loadSlotsForAgent(db: Db, agentId: string): Promise<AgentSlotRow[]> {
  try {
    const rows = await db.execute<AgentSlotRow>(sql`
      SELECT DISTINCT
        a.company_id::text AS "companyId",
        c.id::text         AS "circleId",
        a.id::text         AS "agentId",
        r.id::text         AS "roleId"
      FROM public.agents a
      JOIN plugin_holacracy_c5049b5dfe.role_assignments ra ON ra.agent_id = a.id
      JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id
      JOIN plugin_holacracy_c5049b5dfe.circles c ON c.id = r.circle_id
      WHERE a.id = ${agentId}::uuid
        AND a.status NOT IN ('terminated', 'archived')
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: AgentSlotRow[] }).rows ?? [];
    return list as AgentSlotRow[];
  } catch (err) {
    logger.debug({ err, agentId }, "subscription-compute: per-agent slot lookup failed");
    return [];
  }
}

/**
 * Phase 1.15a — Load open discussion topics this agent participates in.
 * Each row is one (companyId, contextId) pair. The per-agent client manager
 * subscribes to `paperclip/v1/discussion/{companyId}/{contextId}`.
 */
interface DiscussionTopicRow extends Record<string, unknown> {
  companyId: string;
  contextId: string;
}

async function loadAgentDiscussionTopics(db: Db, agentId: string): Promise<DiscussionTopicRow[]> {
  try {
    const rows = await db.execute<DiscussionTopicRow>(sql`
      SELECT
        company_id::text   AS "companyId",
        a2a_context_id     AS "contextId"
      FROM public.circle_discussions
      WHERE status = 'open'
        AND ${agentId}::uuid = ANY(participant_agent_ids)
      LIMIT 50
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: DiscussionTopicRow[] }).rows ?? [];
    return list;
  } catch (err) {
    logger.debug({ err, agentId }, "subscription-compute: discussion topic lookup failed");
    return [];
  }
}

async function loadAgentSkills(db: Db, agentId: string): Promise<AgentSkillRow | null> {
  try {
    const rows = await db.execute<AgentSkillRow>(sql`
      SELECT
        company_id::text                                    AS "companyId",
        id::text                                            AS "agentId",
        COALESCE(accountabilities, '[]'::jsonb)             AS "accountabilities"
      FROM public.agents
      WHERE id = ${agentId}::uuid
        AND status != 'archived'
      LIMIT 1
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: AgentSkillRow[] }).rows ?? [];
    return (list[0] as AgentSkillRow) ?? null;
  } catch (err) {
    logger.debug({ err, agentId }, "subscription-compute: skill lookup failed");
    return null;
  }
}

function extractSkillSlugs(
  accountabilities: Array<Record<string, unknown>> | null | undefined,
): string[] {
  if (!Array.isArray(accountabilities)) return [];
  const slugs = new Set<string>();
  for (const acc of accountabilities) {
    const name =
      acc && typeof acc.name === "string" && acc.name.trim().length > 0
        ? acc.name.trim()
        : null;
    if (!name) continue;
    const slug = slugify(name);
    if (slug.length === 0) continue;
    slugs.add(slug);
  }
  return [...slugs];
}

/**
 * Compute the full desired subscription set for one agent across all six
 * addressing dimensions. The same agent may yield multiple slot entries
 * (one per circle it holds a role in); each yields its own personal-direct
 * + circle-broadcast subscriptions, while role-pool/role-broadcast are
 * per-role and skill-pool/skill-broadcast are per-skill (cross-circle).
 */
export async function computeDesiredSubscriptions(
  db: Db,
  agentId: string,
): Promise<DesiredSubscription[]> {
  const slotRows = await loadSlotsForAgent(db, agentId);
  const skillRow = await loadAgentSkills(db, agentId);
  const skillSlugs = extractSkillSlugs(skillRow?.accountabilities ?? null);
  const discussionTopics = await loadAgentDiscussionTopics(db, agentId);

  const byCircle = new Map<string, { slot: AgentSlot; roles: Set<string> }>();
  for (const row of slotRows) {
    const slot: AgentSlot = {
      companyId: row.companyId,
      circleId: row.circleId,
      agentId: row.agentId,
    };
    const existing = byCircle.get(row.circleId);
    if (existing) {
      existing.roles.add(row.roleId);
    } else {
      byCircle.set(row.circleId, { slot, roles: new Set([row.roleId]) });
    }
  }

  const desired: DesiredSubscription[] = [];
  const seenFilters = new Set<string>();
  const add = (filter: string, slot: AgentSlot): void => {
    if (seenFilters.has(filter)) return;
    seenFilters.add(filter);
    desired.push({ filter, slot });
  };

  for (const [, entry] of byCircle) {
    const { slot } = entry;
    add(requestTopic(slot.companyId, slot.circleId, slot.agentId), slot);
    add(eventCircleWildcard(slot.companyId, slot.circleId), slot);
    for (const roleId of entry.roles) {
      const pool = rolePoolTopic(slot.companyId, slot.circleId, roleId);
      add(sharedSubGroup("paperclip-role", pool), slot);
      add(roleBroadcastTopic(slot.companyId, slot.circleId, roleId), slot);
    }
  }

  // Phase 1.15a — discussion topic subscriptions, one per open discussion.
  for (const d of discussionTopics) {
    const slot: AgentSlot = (() => {
      const firstSlot = [...byCircle.values()][0]?.slot;
      if (firstSlot && firstSlot.companyId === d.companyId) return firstSlot;
      return { companyId: d.companyId, circleId: d.companyId, agentId };
    })();
    add(`paperclip/v1/discussion/${d.companyId}/${d.contextId}`, slot);
  }

  if (skillSlugs.length > 0) {
    const firstSlot = [...byCircle.values()][0]?.slot ?? null;
    const skillSlot: AgentSlot = firstSlot ?? {
      companyId: skillRow?.companyId ?? "",
      circleId: skillRow?.companyId ?? "",
      agentId,
    };
    if (skillSlot.companyId) {
      for (const slug of skillSlugs) {
        const pool = skillPoolTopic(skillSlot.companyId, slug);
        add(sharedSubGroup(`paperclip-skill-${slug}`, pool), skillSlot);
        add(skillBroadcastTopic(skillSlot.companyId, slug), skillSlot);
      }
    }
  }

  return desired;
}

/** Convenience: just the filter strings (no slot tagging). Used by the
 *  per-agent manager, where the connection itself binds the receiver
 *  identity so the slot tagging is redundant. */
export async function computeDesiredFiltersForAgent(
  db: Db,
  agentId: string,
): Promise<string[]> {
  const desired = await computeDesiredSubscriptions(db, agentId);
  return desired.map((d) => d.filter);
}
