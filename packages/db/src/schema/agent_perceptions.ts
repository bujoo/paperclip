import { pgTable, uuid, text, jsonb, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/**
 * Phase 1.13 — Ears (broadcast perceptions).
 *
 * When an event topic (circle broadcast) is delivered to an agent's
 * subscription, the inbound handler records the message here instead of
 * creating a new issue + scheduling a wakeup. Perceptions are peripheral
 * awareness — they flow into the agent's run context the next time the agent
 * wakes for any reason via `buildNeighbourhoodSnapshot`. Direct request-topic
 * Tasks (personal-direct, role-pool, skill-pool) continue to create issues
 * the existing way.
 *
 * Idempotency is enforced at the application layer:
 *  - `idempotency_key = sha256(agentId|topic|payloadHash)` is filled at insert
 *    time. The handler checks for an existing row with the same key inside a
 *    60s window before inserting to dedupe redelivered messages.
 *  - No UNIQUE constraint (the plugin migration validator rejects
 *    `CREATE UNIQUE INDEX`, and older consumed rows are intentionally allowed
 *    to coexist with the same key).
 *
 * The `consumed_at` column is set when `buildNeighbourhoodSnapshot` reads a
 * row into the agent's run context; perceptions are surfaced exactly once.
 */
export const agentPerceptions = pgTable(
  "agent_perceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    userProperties: jsonb("user_properties"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    /** Phase 1.15b — set true by inbound handler when topic matches
     *  paperclip/v1/discussion/{c}/+. Heartbeat scheduler enqueues a wakeup. */
    wakeEligible: boolean("wake_eligible").notNull().default(false),
    wakeProcessedAt: timestamp("wake_processed_at", { withTimezone: true }),
  },
  (table) => ({
    agentConsumedIdx: index("agent_perceptions_agent_consumed_idx").on(
      table.agentId,
      table.consumedAt,
    ),
    agentReceivedIdx: index("agent_perceptions_agent_received_idx").on(
      table.agentId,
      table.receivedAt,
    ),
    idempotencyIdx: index("agent_perceptions_idempotency_idx").on(table.idempotencyKey),
    wakeIdx: index("agent_perceptions_wake_idx").on(
      table.agentId,
      table.wakeEligible,
      table.wakeProcessedAt,
    ),
  }),
);
