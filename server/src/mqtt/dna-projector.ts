/**
 * Company DNA projector — Phase 1.9.
 *
 * Mirrors `agent-card-projector.ts` (retained-message lifecycle owner):
 *  - The host publishes one retained JSON envelope per company to
 *    `paperclip/v1/dna/{companyId}` (QoS 1, retain true).
 *  - Every connected agent (including external A2A agents) subscribes to its
 *    own company's DNA topic and receives the latest envelope at connect.
 *
 * The DNA envelope is a PROJECTION of existing tables, not a new source of
 * truth. Composed from:
 *  - companies.{mission_statement, values, constitution, dna_generation, ...}
 *  - policies (company-scope only)
 *  - agreements (active)
 *  - heuristic_weights (latest per company — may be null until Phase 3)
 *  - domain_registry (Phase 2)
 *  - anchor circle reference
 *
 * Triggers (via the plugin event bus / activity log → MQTT bridge):
 *  - `company.dna.mutated` (direct envelope mutation) → re-project.
 *  - Future: `policy.*`, `agreement.*`, `heuristic_weights.*`,
 *    `domain_registry.*` events should also call `projectDna(companyId)`.
 *    Until those domain events exist, the projector still re-projects on
 *    `company.dna.mutated` and on host bootstrap for every company.
 */

import type { Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { sql } from "drizzle-orm";
import { dnaTopic } from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";
import {
  isMqttInitialised,
  publishRetainedMessage,
} from "./client.js";
import { getCompanyDna } from "../services/company-dna.js";

let _db: Db | null = null;

export function _resetForTesting(): void {
  _db = null;
}

/**
 * Wire the projector. Called from server bootstrap after `initMqtt()`. If MQTT
 * is unreachable the projector still wires the DB reference so future events
 * trigger publishes once the broker comes back.
 */
export async function initDnaProjector(db: Db): Promise<void> {
  _db = db;
  if (!isMqttInitialised()) {
    logger.debug("dna-projector: MQTT not initialised, skipping initial fan-out");
    return;
  }
  // Re-project every company's DNA on boot so any retained envelopes drift
  // from the canonical DB row get refreshed.
  try {
    const rows = await db.execute<{ companyId: string }>(sql`
      SELECT id::text AS "companyId" FROM public.companies WHERE status != 'archived'
    `);
    const list = Array.isArray(rows)
      ? rows
      : (rows as unknown as { rows: Array<{ companyId: string }> }).rows ?? [];
    for (const row of list) {
      try {
        await projectDna(row.companyId, db);
      } catch (err) {
        logger.debug({ err, companyId: row.companyId }, "dna-projector: initial publish failed");
      }
    }
  } catch (err) {
    logger.debug({ err }, "dna-projector: initial enumeration failed");
  }
}

export async function shutdownDnaProjector(): Promise<void> {
  _db = null;
}

/**
 * Project the DNA envelope for one company and publish it retained.
 */
export async function projectDna(companyId: string, db?: Db): Promise<void> {
  if (!isMqttInitialised()) return;
  const database = db ?? _db;
  if (!database) {
    logger.debug({ companyId }, "dna-projector: db not wired, skipping");
    return;
  }
  let envelope;
  try {
    envelope = await getCompanyDna(database, companyId);
  } catch (err) {
    logger.warn({ err, companyId }, "dna-projector: envelope assembly failed");
    return;
  }
  if (!envelope) return;
  try {
    await publishRetainedMessage(dnaTopic(companyId), envelope, {
      contentType: "application/json",
      userProperties: {
        dnaVersion: envelope.dna_version,
        generation: String(envelope.generation),
        publishedBy: "paperclip",
      },
    });
  } catch (err) {
    logger.warn({ err, companyId }, "dna-projector: retained publish failed");
  }
}

/**
 * Event-driven dispatch — bridged from `company.dna.mutated`. The event's
 * `companyId` identifies the affected company.
 */
export async function projectDnaForEvent(event: PluginEvent): Promise<void> {
  if (!isMqttInitialised()) return;
  const companyId = event.companyId ?? null;
  if (!companyId) {
    logger.debug({ eventId: event.eventId }, "dna-projector: event lacks companyId");
    return;
  }
  try {
    await projectDna(companyId);
  } catch (err) {
    logger.warn(
      { err, companyId, eventId: event.eventId },
      "dna-projector: event-driven projection failed",
    );
  }
}
