import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";
import { createA2AClient, subscribeRetained } from "./client.js";
import { discoveryTopic } from "./topics.js";

interface AgentCardSkill {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  tags?: unknown;
}

interface AgentCardPayload {
  skills?: unknown;
}

function parseSkillsFromCard(payload: Buffer): AgentCardSkill[] {
  if (payload.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf-8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const card = parsed as AgentCardPayload;
  if (!Array.isArray(card.skills)) return [];
  return card.skills.filter(
    (entry): entry is AgentCardSkill => !!entry && typeof entry === "object",
  );
}

async function buildSnapshot(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const config = parseObject(ctx.config);
  const brokerUrl = asString(config.brokerUrl, "").trim();
  const companyId =
    asString(config.companyId, "").trim() || asString(ctx.companyId, "").trim();
  const circleId = asString(config.circleId, "").trim();
  const agentId =
    asString(config.agentId, "").trim() || asString(ctx.agentId, "").trim();
  const username = asString(config.username, "").trim() || undefined;
  const password = asString(config.password, "").trim() || undefined;
  const waitMs = Math.max(100, Math.floor(asNumber(config.cardWaitMs, 1500)));

  const warnings: string[] = [];
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];

  if (!brokerUrl) {
    warnings.push(
      "adapterConfig.brokerUrl is not set; cannot read Agent Card from MQTT.",
    );
    return {
      adapterType: ctx.adapterType,
      supported: true,
      mode: "ephemeral",
      desiredSkills,
      entries,
      warnings,
    };
  }
  if (!companyId || !circleId || !agentId) {
    warnings.push(
      "Need companyId, circleId, and agentId to locate the Agent Card on the discovery topic.",
    );
    return {
      adapterType: ctx.adapterType,
      supported: true,
      mode: "ephemeral",
      desiredSkills,
      entries,
      warnings,
    };
  }

  const topic = discoveryTopic(companyId, circleId, agentId);
  let cardSkills: AgentCardSkill[] = [];
  let probeError: string | null = null;
  let client: Awaited<ReturnType<typeof createA2AClient>> | null = null;

  try {
    client = await createA2AClient({
      brokerUrl,
      clientId: `paperclip-skills-${randomUUID().slice(0, 8)}`,
      username,
      password,
      cleanStart: true,
      keepalive: 30,
    });

    const unsub = await subscribeRetained(client, topic, (msg) => {
      if (!msg.retain) return;
      const skills = parseSkillsFromCard(msg.payload);
      if (skills.length > 0) cardSkills = skills;
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await unsub();
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  } finally {
    if (client) {
      try {
        await client.endAsync(false);
      } catch {
        // ignore
      }
    }
  }

  if (probeError) {
    warnings.push(`Failed to query Agent Card from MQTT: ${probeError}`);
    return {
      adapterType: ctx.adapterType,
      supported: true,
      mode: "ephemeral",
      desiredSkills,
      entries,
      warnings,
    };
  }

  if (cardSkills.length === 0) {
    warnings.push(
      `No retained Agent Card on ${topic} (or Card has no skills).`,
    );
  }

  for (const skill of cardSkills) {
    const id = typeof skill.id === "string" ? skill.id : null;
    const name = typeof skill.name === "string" ? skill.name : null;
    const key = (id ?? name ?? "").trim();
    if (!key) continue;
    entries.push({
      key,
      runtimeName: name ?? key,
      desired: desiredSet.has(key),
      managed: false,
      state: "external",
      origin: "external_unknown",
      originLabel: "Provided by external A2A agent",
      readOnly: true,
      detail:
        typeof skill.description === "string" ? skill.description : null,
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  // Include any desired skill not advertised on the card as state=missing so
  // operators can see the gap.
  for (const desired of desiredSkills) {
    if (entries.some((e) => e.key === desired)) continue;
    entries.push({
      key: desired,
      runtimeName: null,
      desired: true,
      managed: false,
      state: "missing",
      origin: "external_unknown",
      originLabel: "Not advertised on Agent Card",
      readOnly: true,
      detail:
        "This skill is desired but is not declared in the agent's published A2A Card.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listA2AMqttSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx, []);
}

export async function syncA2AMqttSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx, desiredSkills);
}
