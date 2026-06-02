import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";
import { createA2AClient, subscribeRetained } from "./client.js";
import { discoveryTopic } from "./topics.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

/**
 * Test that:
 *   1. The broker URL is configured and we can open a CONNACK-clean MQTT v5 session.
 *   2. The target agent's discovery topic carries a retained Agent Card.
 *
 * Either failure produces a level=error check, which surfaces as status=fail.
 * A missing Card with an otherwise-good broker is a warn (the host's Agent
 * Card projector may not have re-published yet).
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const brokerUrl = asString(config.brokerUrl, "").trim();
  const companyId =
    asString(config.companyId, "").trim() ||
    asString((ctx as { companyId?: unknown }).companyId, "").trim();
  const circleId = asString(config.circleId, "").trim();
  const agentId = asString(config.agentId, "").trim();
  const username = asString(config.username, "").trim() || undefined;
  const password = asString(config.password, "").trim() || undefined;
  const cardWaitMs = Math.max(
    100,
    Math.floor(asNumber(config.cardWaitMs, 2000)),
  );

  if (!brokerUrl) {
    checks.push({
      code: "a2a_mqtt_broker_url_missing",
      level: "error",
      message: "adapterConfig.brokerUrl is required.",
      hint: "Set e.g. mqtt://localhost:1883 or mqtts://emqx.example.com:8883.",
    });
    return finalize(ctx, checks);
  }

  checks.push({
    code: "a2a_mqtt_broker_url_set",
    level: "info",
    message: `MQTT broker URL: ${brokerUrl}`,
  });

  // 1. Probe broker connection.
  const probeClientId = `paperclip-probe-${randomUUID().slice(0, 8)}`;
  let connected = false;
  try {
    const probe = await createA2AClient({
      brokerUrl,
      clientId: probeClientId,
      username,
      password,
      cleanStart: true,
      keepalive: 30,
    });
    connected = true;
    checks.push({
      code: "a2a_mqtt_broker_connect_ok",
      level: "info",
      message: "Connected to MQTT broker (CONNACK clean).",
    });

    // 2. If we know the (company, circle, agent), check the discovery topic
    //    for a retained Agent Card.
    if (companyId && circleId && agentId) {
      const topic = discoveryTopic(companyId, circleId, agentId);
      let cardSeen = false;
      try {
        const unsub = await subscribeRetained(probe, topic, (msg) => {
          if (msg.retain && msg.payload.length > 0) {
            cardSeen = true;
          }
        });
        await new Promise((resolve) => setTimeout(resolve, cardWaitMs));
        await unsub();

        if (cardSeen) {
          checks.push({
            code: "a2a_mqtt_card_present",
            level: "info",
            message: `Retained Agent Card found on ${topic}.`,
          });
        } else {
          checks.push({
            code: "a2a_mqtt_card_missing",
            level: "warn",
            message: `No retained Agent Card on ${topic} after ${cardWaitMs}ms.`,
            hint:
              "The host's Agent Card projector may not have re-published yet, " +
              "or the agent is paused/archived.",
          });
        }
      } catch (cardErr) {
        checks.push({
          code: "a2a_mqtt_card_probe_failed",
          level: "warn",
          message: `Card discovery probe failed: ${cardErr instanceof Error ? cardErr.message : String(cardErr)}`,
        });
      }
    } else {
      checks.push({
        code: "a2a_mqtt_card_probe_skipped",
        level: "info",
        message:
          "Skipping Agent Card discovery probe — adapterConfig.{companyId,circleId,agentId} not all set.",
      });
    }

    try {
      await probe.endAsync(false);
    } catch {
      // ignore
    }
  } catch (err) {
    if (!connected) {
      checks.push({
        code: "a2a_mqtt_broker_connect_failed",
        level: "error",
        message: `Failed to connect to MQTT broker: ${err instanceof Error ? err.message : String(err)}`,
        hint:
          "Verify brokerUrl, network reachability, and credentials. " +
          "For EMQX in Docker, the default is mqtt://localhost:1883.",
      });
    } else {
      checks.push({
        code: "a2a_mqtt_test_error",
        level: "error",
        message: `Probe error after connect: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return finalize(ctx, checks);
}

function finalize(
  ctx: AdapterEnvironmentTestContext,
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult {
  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
