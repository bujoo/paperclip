/**
 * Plugin-event-bus → MQTT bridge.
 *
 * Called from `plugin-event-bus.ts:emit()` after in-process plugin handlers
 * have run. Inspects the domain event type and forwards a curated subset to
 * MQTT topics so external A2A agents (subscribers on `paperclip/v1/event/...`
 * or the discovery channel) can react to lifecycle changes.
 *
 * Design notes:
 *  - This module is intentionally lossy. Most plugin events stay in-process;
 *    we only republish events that are part of the A2A contract (Agent Cards,
 *    role changes, approval outcomes, IDM phase transitions, issue lifecycle
 *    when a circle context is resolvable).
 *  - The bridge never blocks the caller. `plugin-event-bus.ts:197` invokes
 *    `void publishEventToMqtt(event).catch(log)` so broker latency or outages
 *    don't stall in-process plugin delivery.
 *  - Idempotency: every published message carries `eventId` in MQTT v5 user
 *    properties so downstream subscribers can dedupe by domain event ID
 *    rather than relying on the broker's at-least-once semantics alone.
 *  - Card lifecycle events (`agent.*`) are NOT republished here — they are
 *    delegated to the Agent Card projector, which owns retained-message
 *    publishing on the discovery topic.
 *
 * @see /Users/tom/.claude/plans/okay-and-how-could-giggly-unicorn.md
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { eventTopic, idmPhaseTopic } from "@paperclipai/adapter-a2a-mqtt/server";
import { logger } from "../middleware/logger.js";
import { isMqttInitialised, publish } from "./client.js";
import { projectAgentCardForEvent } from "./agent-card-projector.js";
import { invalidateAclCache } from "./acl-backend.js";
import {
  handleIssueLifecycleEventForA2A,
  reconcileAgentRuntimeSubscriptions,
  resolveA2AOriginIssueTopicTuple,
} from "./agent-runtime-bridge.js";
// Phase 1.8 — bridge harness-liveness escalation + watchdog decision events
// to MQTT host-event topics. Phase 1.9 — re-project DNA on `company.dna.mutated`.
import {
  publishLivenessEscalationToMqtt,
  publishWatchdogDecisionToMqtt,
} from "./heartbeat-bridge.js";
import { projectDnaForEvent } from "./dna-projector.js";

/**
 * Resolve the per-event MQTT user properties common to all bridged events.
 * Subscribers can use `eventId` to dedupe and `eventType` / `actorType` to
 * filter without parsing the payload.
 */
function commonUserProperties(event: PluginEvent): Record<string, string> {
  const props: Record<string, string> = {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    publishedBy: "paperclip",
  };
  if (event.actorType) props.actorType = event.actorType;
  if (event.actorId) props.actorId = event.actorId;
  if (event.entityType) props.entityType = event.entityType;
  if (event.entityId) props.entityId = event.entityId;
  return props;
}

/**
 * Try to resolve a `(companyId, circleId, agentId)` triple from an event
 * payload. Returns null when the event doesn't carry enough context to land
 * on a per-agent event topic.
 *
 * Today, circleId is only carried on events emitted by plugin-holacracy or by
 * core code that has been updated to include it. Until that's universal, this
 * returns null for issue.* and tension.* and we drop those events with a
 * debug log (we keep the dispatch but won't publish — see `publishEventToMqtt`).
 */
function resolveAgentTopicTuple(event: PluginEvent):
  | { companyId: string; circleId: string; agentId: string }
  | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const companyId = event.companyId ?? null;
  const circleId =
    typeof payload.circleId === "string" && payload.circleId.length > 0
      ? payload.circleId
      : null;
  const agentId =
    event.entityType === "agent" && event.entityId
      ? event.entityId
      : typeof payload.agentId === "string" && payload.agentId.length > 0
        ? payload.agentId
        : null;
  if (!companyId || !circleId || !agentId) return null;
  return { companyId, circleId, agentId };
}

function resolveIdmTopicTuple(event: PluginEvent):
  | { companyId: string; circleId: string; idmId: string }
  | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const companyId = event.companyId ?? null;
  const circleId =
    typeof payload.circleId === "string" && payload.circleId.length > 0
      ? payload.circleId
      : null;
  const idmId =
    typeof payload.idmId === "string" && payload.idmId.length > 0
      ? payload.idmId
      : event.entityType === "idm" && event.entityId
        ? event.entityId
        : null;
  if (!companyId || !circleId || !idmId) return null;
  return { companyId, circleId, idmId };
}

/**
 * Bridge entry point. Called from `plugin-event-bus.emit()` after in-process
 * handlers have run. Safe to invoke with `void bridge.publishEventToMqtt(...)
 * .catch(log)` — never throws, never blocks the caller for broker latency.
 */
export async function publishEventToMqtt(event: PluginEvent): Promise<void> {
  if (!isMqttInitialised()) {
    // MQTT is optional in test/dev environments. Skip silently so tests that
    // don't boot the broker still exercise the event bus.
    return;
  }

  try {
    switch (event.eventType) {
      // --- Agent lifecycle → re-project Card (no direct publish here) -------
      case "agent.created":
      case "agent.updated":
      case "agent.status_changed":
        await projectAgentCardForEvent(event);
        return;

      // --- Approvals --------------------------------------------------------
      case "approval.decided": {
        // Resolve the approver. The event's payload (from activity-log) is the
        // sanitised activity details; the deciding actor is on the event
        // metadata. We use whichever agentId we can extract.
        const tuple = resolveAgentTopicTuple(event);
        if (!tuple) {
          logger.debug({ eventId: event.eventId }, "mqtt bridge: approval.decided missing topic tuple, dropping");
          return;
        }
        await publish(
          eventTopic(tuple.companyId, tuple.circleId, tuple.agentId),
          event,
          { qos: 1, retain: false, userProperties: commonUserProperties(event) },
        );
        return;
      }

      // --- Phase 1.8 — host liveness / watchdog event bridge ----------------
      case "issue.harness_liveness_escalation":
        await publishLivenessEscalationToMqtt(event);
        return;
      case "heartbeat.watchdog_decision":
        await publishWatchdogDecisionToMqtt(event);
        return;

      // --- Phase 1.9 — Company DNA re-projection ---------------------------
      case "company.dna.mutated":
        await projectDnaForEvent(event);
        return;

      // --- Issue lifecycle (best-effort, requires circleId in payload) ------
      case "issue.created":
      case "issue.updated":
      case "issue.comment.created":
      case "issue.relations.updated":
      case "issue.checked_out":
      case "issue.released":
      case "issue.assignment_wakeup_requested": {
        // First: if this is a terminal issue.updated for an issue that
        // originated from an A2A request, fan out a Task reply on the
        // stored Response Topic. Independent of the per-agent event
        // publish — failures here must not block the bridge publish.
        if (event.eventType === "issue.updated") {
          try {
            await handleIssueLifecycleEventForA2A(event);
          } catch (err) {
            logger.debug(
              { err, eventId: event.eventId },
              "mqtt bridge: A2A lifecycle hook failed",
            );
          }
        }

        let tuple = resolveAgentTopicTuple(event);
        if (!tuple) {
          // Phase 1.13 — for issues that originated from an A2A request the
          // payload lineage is the request topic (no circle). Fall back to a
          // DB lookup that walks the assignee's role assignment so we can
          // still emit a per-agent event topic notification.
          const issueId =
            event.entityType === "issue" && typeof event.entityId === "string"
              ? event.entityId
              : null;
          if (issueId) {
            try {
              tuple = await resolveA2AOriginIssueTopicTuple(issueId);
            } catch (err) {
              logger.debug(
                { err, eventId: event.eventId, issueId },
                "mqtt bridge: A2A origin tuple fallback failed",
              );
            }
          }
        }
        if (!tuple) {
          // Core domain emits issue.* without circleId today; drop quietly.
          logger.debug(
            { eventId: event.eventId, eventType: event.eventType },
            "mqtt bridge: issue event lacks circle context, dropping",
          );
          return;
        }
        await publish(
          eventTopic(tuple.companyId, tuple.circleId, tuple.agentId),
          event,
          { qos: 1, retain: false, userProperties: commonUserProperties(event) },
        );
        return;
      }

      // --- IDM phase transitions (plugin-holacracy may emit these) ---------
      // Holacracy plugin events surface as `plugin.<id>.<name>`; check by
      // payload shape rather than exact name so we don't couple the bridge
      // to one plugin's namespacing.
      default: {
        if (
          typeof event.eventType === "string" &&
          (event.eventType.endsWith(".idm.phase_changed") ||
            event.eventType.endsWith(".idm.transitioned"))
        ) {
          const tuple = resolveIdmTopicTuple(event);
          if (!tuple) {
            logger.debug(
              { eventId: event.eventId, eventType: event.eventType },
              "mqtt bridge: IDM phase event lacks topic tuple, dropping",
            );
            return;
          }
          await publish(
            idmPhaseTopic(tuple.companyId, tuple.circleId, tuple.idmId),
            event,
            { qos: 1, retain: false, userProperties: commonUserProperties(event) },
          );
          return;
        }

        // Role assignment lifecycle (plugin-holacracy):
        //   plugin.<id>.role_assignment.created
        //   plugin.<id>.role_assignment.deleted
        if (
          typeof event.eventType === "string" &&
          (event.eventType.includes(".role_assignment.created") ||
            event.eventType.includes(".role_assignment.deleted"))
        ) {
          // Cards depend on role membership; the ACL allowlist depends on it
          // too. Invalidate the cache so the next ACL fetch reflects reality.
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const agentId =
            typeof payload.agentId === "string" ? payload.agentId : null;
          invalidateAclCache(agentId);
          await projectAgentCardForEvent(event);
          // Keep the per-agent request-topic subscription set in sync with
          // current role membership without a process restart. Best-effort —
          // the runtime bridge logs its own failures.
          if (agentId) {
            try {
              await reconcileAgentRuntimeSubscriptions(agentId);
            } catch (err) {
              logger.debug(
                { err, agentId, eventId: event.eventId },
                "mqtt bridge: agent-runtime reconcile failed",
              );
            }
          }
          return;
        }

        // Everything else — drop. Subscribers wanting deep visibility can use
        // ctx.events.subscribe in-process; MQTT is reserved for inter-runtime
        // signalling, not a firehose mirror of activity-log.
        logger.debug(
          { eventId: event.eventId, eventType: event.eventType },
          "mqtt bridge: event type not bridged, dropping",
        );
        return;
      }
    }
  } catch (err) {
    logger.warn(
      { err, eventId: event.eventId, eventType: event.eventType },
      "mqtt bridge: publish failed",
    );
  }
}
