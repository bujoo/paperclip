import { pgTable, uuid, text, jsonb, timestamp, index, customType } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

/**
 * Sidecar table for the A2A runtime bridge (`server/src/mqtt/agent-runtime-bridge.ts`).
 *
 * When an external A2A agent (or another Paperclip agent via the `a2a_mqtt`
 * adapter) publishes a Task request on
 *   `paperclip/v1/request/{companyId}/{circleId}/{agentId}`
 * the runtime bridge creates an `issues` row to drive the work through the
 * normal heartbeat/execution pipeline. The MQTT v5 Response Topic +
 * Correlation Data + User Properties from the original request are stashed
 * here so the bridge can publish a matching Task reply when the issue
 * transitions to `done` or `failed`.
 *
 * One row per pending A2A-originated issue. Deleted on terminal status, or
 * cascaded if the issue itself is deleted.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const a2aPendingReplies = pgTable(
  "a2a_pending_replies",
  {
    issueId: uuid("issue_id")
      .primaryKey()
      .references(() => issues.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    responseTopic: text("response_topic").notNull(),
    correlationData: bytea("correlation_data"),
    userProperties: jsonb("user_properties")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index("a2a_pending_replies_task_idx").on(table.taskId),
  }),
);
