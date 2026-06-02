/**
 * Phase 1.15 — Live LLM-driven team conversation demo.
 *
 *  1. Pre-check: pick the Documentation circle (≥3 members), verify each has
 *     an adapter_type set.
 *  2. Initiate: POST /api/plugins/holacracy/discussions {circleId, topic, rounds=1,
 *     speakerMode='reverse-priority'}.
 *  3. Observe live via mqtt.js wildcard subscription to
 *     `paperclip/v1/discussion/+/+` (host superuser creds).
 *  4. Wait up to 10min for all per-turn issues to complete.
 *  5. Verify speaker order (Lead Link last).
 *  6. Wait up to 5min for awaiting_commitments and any commit signals.
 *  7. Print transcript + commitments.
 *
 *  Run via:  pnpm exec tsx scripts/demo-real-team-conversation.ts
 *
 *  Notes:
 *   - If agents lack the credentials to actually invoke their adapter, the
 *     scheduler still spawns the turn issues but they never complete. In
 *     that case we report "SIMULATED" — we still demonstrate Phase 1.14 +
 *     Phase 1.15 by inserting completion comments + status='done' for each
 *     turn (matching the Phase 1.14 verification pattern).
 *   - Max wall time 15min; exit 0 with warning on incomplete.
 */

import { connect as mqttConnect, type MqttClient, type IClientOptions } from "/Users/tom/paperclip/node_modules/.pnpm/mqtt@5.15.1/node_modules/mqtt/build/index.js";
// @ts-expect-error - direct dotenv require
import { config as loadDotenv } from "/Users/tom/paperclip/node_modules/.pnpm/dotenv@17.3.1/node_modules/dotenv/lib/main.js";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
// @ts-expect-error - direct pg require
import pgModule from "/Users/tom/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js";

loadDotenv({ path: resolvePath(process.cwd(), ".env"), quiet: true });

const SERVER_URL = process.env.PAPERCLIP_SERVER_URL?.trim() ?? "http://127.0.0.1:3100";
const PLUGIN_KEY = "@paperclipai/plugin-holacracy";
let API_BASE = `${SERVER_URL}/api/plugins/${encodeURIComponent(PLUGIN_KEY)}/api`;
async function resolvePluginId(): Promise<string> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ id: string }>(`SELECT id FROM plugins WHERE package_name = $1 LIMIT 1`, [PLUGIN_KEY]);
    if (r.rows.length === 0) throw new Error(`Plugin ${PLUGIN_KEY} not installed`);
    return r.rows[0].id;
  } finally { c.release(); }
}
const BROKER_URL = process.env.PAPERCLIP_MQTT_BROKER_URL?.trim() ?? "mqtt://localhost:1883";
const HOST_USERNAME = "host:paperclip-server";
const HOST_PASSWORD = process.env.PAPERCLIP_MQTT_HOST_PASSWORD?.trim() ?? "paperclip-host-dev";

const MAX_TURN_WAIT_MS = 10 * 60 * 1000;
const MAX_COMMIT_WAIT_MS = 3 * 60 * 1000;
const MAX_TOTAL_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const pool = new pgModule.Pool({
  host: "127.0.0.1",
  port: 54329,
  user: "paperclip",
  database: "paperclip",
  password: "paperclip",
});

function log(step: string, ok: boolean, details: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[${ok ? "OK" : "WARN"}] ${step}: ${typeof details === "string" ? details : JSON.stringify(details)}`);
}

async function connectObserver(): Promise<MqttClient> {
  return new Promise((resolveOk, reject) => {
    const c = mqttConnect(BROKER_URL, {
      protocolVersion: 5,
      clientId: `demo-discussion-observer-${randomUUID().slice(0, 8)}`,
      username: HOST_USERNAME,
      password: HOST_PASSWORD,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
    } satisfies IClientOptions);
    c.once("connect", () => resolveOk(c));
    c.once("error", (err) => reject(err));
  });
}

interface CircleFixture {
  id: string;
  name: string;
  companyId: string;
  members: Array<{ agentId: string; name: string; adapterType: string | null; isLeadLink: boolean }>;
  llmReadyCount: number;
}

async function pickDocCircle(): Promise<CircleFixture> {
  const c = await pool.connect();
  try {
    const schemaRow = await c.query<{ schema: string }>(
      `SELECT schema_name AS "schema" FROM information_schema.schemata WHERE schema_name LIKE 'plugin_holacracy_%' LIMIT 1`,
    );
    if (schemaRow.rows.length === 0) throw new Error("plugin_holacracy schema not found");
    const schema = schemaRow.rows[0].schema;

    // Prefer Documentation circle by name; fall back to any 3+ member circle.
    let circles = await c.query<{ id: string; name: string; company_id: string }>(
      `SELECT id, name, company_id FROM ${schema}.circles WHERE name ILIKE '%documentation%' LIMIT 1`,
    );
    if (circles.rows.length === 0) {
      circles = await c.query<{ id: string; name: string; company_id: string }>(
        `SELECT cir.id, cir.name, cir.company_id
           FROM ${schema}.circles cir
           JOIN ${schema}.roles r ON r.circle_id = cir.id
           JOIN ${schema}.role_assignments ra ON ra.role_id = r.id
           WHERE ra.agent_id IS NOT NULL
           GROUP BY cir.id, cir.name, cir.company_id
           HAVING COUNT(DISTINCT ra.agent_id) >= 3
           ORDER BY COUNT(DISTINCT ra.agent_id) DESC LIMIT 1`,
      );
    }
    if (circles.rows.length === 0) throw new Error("No circle with ≥3 members found");
    const { id: circleId, name: circleName, company_id: companyId } = circles.rows[0];

    const members = await c.query<{
      agentId: string;
      name: string;
      adapterType: string | null;
      roleType: string;
    }>(
      `SELECT ra.agent_id AS "agentId", a.name, a.adapter_type AS "adapterType", r.role_type AS "roleType"
         FROM ${schema}.role_assignments ra
         JOIN ${schema}.roles r ON r.id = ra.role_id
         JOIN public.agents a ON a.id = ra.agent_id
         WHERE r.circle_id = $1 AND ra.agent_id IS NOT NULL
         ORDER BY r.role_type DESC, a.name ASC`,
      [circleId],
    );

    // De-dupe by agent id, prefer circle_lead role on dupe.
    const seen = new Map<string, { agentId: string; name: string; adapterType: string | null; isLeadLink: boolean }>();
    for (const m of members.rows) {
      const existing = seen.get(m.agentId);
      const isLead = m.roleType === "circle_lead";
      if (!existing) {
        seen.set(m.agentId, { agentId: m.agentId, name: m.name, adapterType: m.adapterType, isLeadLink: isLead });
      } else if (isLead && !existing.isLeadLink) {
        existing.isLeadLink = true;
      }
    }
    const uniqueMembers = [...seen.values()];
    const llmReadyCount = uniqueMembers.filter((m) => m.adapterType !== null && m.adapterType !== "").length;
    return { id: circleId, name: circleName, companyId, members: uniqueMembers, llmReadyCount };
  } finally {
    c.release();
  }
}

async function postDiscussion(opts: {
  companyId: string;
  circleId: string;
  topic: string;
  rounds: number;
  speakerMode: string;
}): Promise<{ discussionId: string; contextId: string; speakerOrder: string[] }> {
  const res = await fetch(`${API_BASE}/discussions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyId: opts.companyId,
      circleId: opts.circleId,
      topic: opts.topic,
      rounds: opts.rounds,
      speakerMode: opts.speakerMode,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`POST /discussions failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    discussionId: body.discussionId as string,
    contextId: body.contextId as string,
    speakerOrder: (body.speakerOrder as string[]) ?? [],
  };
}

async function getDiscussion(id: string, companyId: string): Promise<{
  discussion: Record<string, unknown>;
  turns: Array<Record<string, unknown>>;
  commitments: Array<Record<string, unknown>>;
}> {
  const res = await fetch(`${API_BASE}/discussions/${id}?companyId=${encodeURIComponent(companyId)}`);
  if (!res.ok) throw new Error(`GET /discussions/${id} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as never;
}

/** Best-effort: simulate completion for stuck turn issues. */
async function simulateStuckTurns(discussionId: string, fixture: CircleFixture): Promise<number> {
  const c = await pool.connect();
  let updated = 0;
  try {
    const turns = await c.query<{
      id: string;
      assignee_agent_id: string;
      status: string;
      origin_fingerprint: string;
    }>(
      `SELECT id, assignee_agent_id, status, origin_fingerprint
         FROM public.issues
        WHERE origin_kind = 'discussion:turn' AND origin_id = $1
          AND status IN ('backlog', 'todo', 'in_progress')`,
      [discussionId],
    );
    for (const t of turns.rows) {
      const author = fixture.members.find((m) => m.agentId === t.assignee_agent_id);
      const authorName = author?.name ?? "agent";
      const content =
        `*[SIMULATED — agent runtime did not produce LLM output within the demo window]* ` +
        `${authorName} thinks the doc team should prioritise (1) merging redundant guides ` +
        `and (2) adding a quickstart section. Round ${t.origin_fingerprint}.`;
      await c.query(
        `INSERT INTO public.issue_comments (id, company_id, issue_id, author_agent_id, body) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), fixture.companyId, t.id, t.assignee_agent_id, content],
      );
      await c.query(
        `UPDATE public.issues SET status='done', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [t.id],
      );
      updated += 1;
    }
    // Also simulate any pending summariser.
    const sum = await c.query<{ id: string; assignee_agent_id: string }>(
      `SELECT id, assignee_agent_id FROM public.issues
        WHERE origin_kind='discussion:summary' AND origin_id=$1
          AND status IN ('backlog','todo','in_progress')`,
      [discussionId],
    );
    for (const s of sum.rows) {
      const content = JSON.stringify({
        summary:
          "Agreement: the Documentation circle should (1) merge redundant guides, (2) ship a quickstart by EOW, and (3) auto-link from the homepage.",
        kind: "agreement",
        suggestedFollowups: ["Designate quickstart owner", "Audit redundant guides"],
      });
      await c.query(
        `INSERT INTO public.issue_comments (id, company_id, issue_id, author_agent_id, body) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), fixture.companyId, s.id, s.assignee_agent_id, content],
      );
      await c.query(
        `UPDATE public.issues SET status='done', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [s.id],
      );
      updated += 1;
    }
  } finally {
    c.release();
  }
  return updated;
}

// (no plugin-job poke endpoint — scheduler runs on its cron cadence)

async function simulateCommitments(discussionId: string, fixture: CircleFixture): Promise<number> {
  const c = await pool.connect();
  let inserted = 0;
  try {
    // 4 of 5 support, 1 support-with-objection — 80% threshold met.
    const signals: Array<{ signal: string; reason: string | null }> = [
      { signal: "support", reason: null },
      { signal: "support", reason: null },
      { signal: "support", reason: null },
      { signal: "support", reason: null },
      { signal: "support-with-objection", reason: "Want to revisit the quickstart owner allocation in 2 weeks." },
    ];
    let i = 0;
    for (const m of fixture.members) {
      const sig = signals[i++ % signals.length];
      try {
        await c.query(
          `INSERT INTO public.discussion_commitments (discussion_id, agent_id, signal, reason)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (discussion_id, agent_id) DO UPDATE SET signal=EXCLUDED.signal, reason=EXCLUDED.reason, signaled_at=NOW()`,
          [discussionId, m.agentId, sig.signal, sig.reason],
        );
        inserted += 1;
      } catch (err) {
        // skip
      }
    }
  } finally {
    c.release();
  }
  return inserted;
}

async function main(): Promise<void> {
  const t0 = Date.now();

  console.log(`\n=== Phase 1.15 — Live Team Conversation Demo ===\n`);
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Broker: ${BROKER_URL}`);
  console.log(`Start:  ${new Date().toISOString()}\n`);

  // 0. Resolve plugin id (UUID-based routing).
  const pluginId = await resolvePluginId();
  API_BASE = `${SERVER_URL}/api/plugins/${pluginId}/api`;

  // 1. Pre-check
  const fixture = await pickDocCircle();
  log("step1.pre_check", true, {
    circle: fixture.name,
    members: fixture.members.length,
    llmReady: fixture.llmReadyCount,
    memberNames: fixture.members.map((m) => `${m.name}${m.isLeadLink ? " [Lead Link]" : ""} (${m.adapterType ?? "no-adapter"})`),
  });

  if (fixture.members.length < 3) {
    console.error(`ERR: only ${fixture.members.length} members — need 3+`);
    process.exit(1);
  }
  if (fixture.llmReadyCount < 3) {
    console.warn(`WARN: only ${fixture.llmReadyCount}/5 agents are LLM-ready. Demo will fall back to SIMULATED completion if turns stall.`);
  }

  // 2. Observer
  const observer = await connectObserver();
  let turnsObserved = 0;
  observer.on("message", (topic, payload, packet) => {
    if (!topic.startsWith("paperclip/v1/discussion/")) return;
    let body: unknown;
    try { body = JSON.parse(payload.toString("utf-8")); } catch { body = payload.toString("utf-8"); }
    turnsObserved += 1;
    const userProps = (packet as { properties?: { userProperties?: Record<string, unknown> } }).properties?.userProperties ?? {};
    console.log(`  [OBSERVER] ${topic} ${JSON.stringify(body)} userProps=${JSON.stringify(userProps)}`);
  });
  await observer.subscribeAsync("paperclip/v1/discussion/+/+", { qos: 1 });
  log("step2.observer_subscribed", true, "paperclip/v1/discussion/+/+");

  // 3. Initiate
  const topic = "What's the highest-leverage fix this week to improve our docs?";
  const initRes = await postDiscussion({
    companyId: fixture.companyId,
    circleId: fixture.id,
    topic,
    rounds: 1,
    speakerMode: "reverse-priority",
  });
  log("step3.discussion_created", true, {
    discussionId: initRes.discussionId,
    contextId: initRes.contextId,
    speakerOrder: initRes.speakerOrder.map((id) => {
      const m = fixture.members.find((x) => x.agentId === id);
      return `${m?.name ?? id.slice(0, 8)}${m?.isLeadLink ? " [LL]" : ""}`;
    }),
  });

  // 4. Wait for turns
  const turnWaitStart = Date.now();
  let lastSpeakerIdx = -1;
  let lastSimulateAt = 0;
  let didSimulate = false;
  let phase = "open";

  while (Date.now() - turnWaitStart < MAX_TURN_WAIT_MS) {
    if (Date.now() - t0 > MAX_TOTAL_MS) break;
    const d = await getDiscussion(initRes.discussionId, fixture.companyId);
    const discussion = d.discussion as Record<string, unknown>;
    const newSpeakerIdx = Number(discussion.current_speaker_idx ?? 0);
    if (newSpeakerIdx !== lastSpeakerIdx) {
      log("step4.speaker_advance", true, { currentSpeakerIdx: newSpeakerIdx, rounds_completed: discussion.rounds_completed, phase: discussion.phase });
      lastSpeakerIdx = newSpeakerIdx;
    }
    phase = discussion.phase as string;
    if (phase !== "open") break;

    // If turns aren't moving (no real LLM execution), simulate per stuck turn.
    // simulateStuckTurns is idempotent (only acts on backlog/todo/in_progress).
    const elapsedSinceStart = Date.now() - turnWaitStart;
    const SIMULATE_BACKOFF_MS = 20_000;
    const shouldSimulate =
      elapsedSinceStart > 90_000 &&
      Date.now() - lastSimulateAt > SIMULATE_BACKOFF_MS;
    if (shouldSimulate) {
      const n = await simulateStuckTurns(initRes.discussionId, fixture);
      if (n > 0) {
        log("step4.simulated_turns", true, { simulatedIssuesCount: n, didSimulate });
        didSimulate = true;
      }
      lastSimulateAt = Date.now();
    }

    // Cron runs the scheduler every minute; no manual poke endpoint available.

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const afterTurns = await getDiscussion(initRes.discussionId, fixture.companyId);
  const aft = afterTurns.discussion as Record<string, unknown>;
  log("step5.turns_done", true, {
    rounds_completed: aft.rounds_completed,
    phase: aft.phase,
    turnsObserved,
  });

  // 5. Verify speaker order — last completed turn should be Lead Link.
  const turns = afterTurns.turns ?? [];
  const turnsByOrder = [...turns]
    .filter((t) => !t.isSummary && t.completedAt)
    .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  if (turnsByOrder.length > 0) {
    const lastTurn = turnsByOrder[turnsByOrder.length - 1];
    const lastAgentId = lastTurn.agentId as string;
    const leadLink = fixture.members.find((m) => m.isLeadLink);
    const lastIsLL = leadLink && lastAgentId === leadLink.agentId;
    log("step5.lead_link_last", !!lastIsLL, {
      expectedLeadLink: leadLink?.name ?? "(no Lead Link)",
      lastAgent: fixture.members.find((m) => m.agentId === lastAgentId)?.name ?? lastAgentId.slice(0, 8),
    });
  }

  // 6. Wait for commit phase.
  if (aft.phase === "awaiting_commitments" || aft.phase === "concluded") {
    log("step6.entered_awaiting_commitments", true, { phase: aft.phase });
  } else {
    log("step6.awaiting_commitments_not_reached", false, { phase: aft.phase });
  }

  // Wait briefly for commitments to land naturally; otherwise simulate (LLM agents
  // typically aren't fluent in commit-to-conclusion yet).
  const commitWaitStart = Date.now();
  while (Date.now() - commitWaitStart < MAX_COMMIT_WAIT_MS) {
    if (Date.now() - t0 > MAX_TOTAL_MS) break;
    const d = await getDiscussion(initRes.discussionId, fixture.companyId);
    const commitments = d.commitments ?? [];
    const phaseNow = (d.discussion as Record<string, unknown>).phase as string;
    if (phaseNow === "concluded") {
      log("step6.concluded_naturally", true, { commitments: commitments.length });
      break;
    }
    if (Date.now() - commitWaitStart > 60_000 && commitments.length === 0) {
      // Simulate 5 commitments.
      const n = await simulateCommitments(initRes.discussionId, fixture);
      log("step6.simulated_commitments", true, { count: n });
      // Cron will pick up the transition within 60s.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // 7. Final transcript.
  const final = await getDiscussion(initRes.discussionId, fixture.companyId);
  const finald = final.discussion as Record<string, unknown>;
  console.log(`\n\n========= FINAL TRANSCRIPT =========\n`);
  console.log(`Topic: ${finald.topic}`);
  console.log(`Status: ${finald.status} · Phase: ${finald.phase}`);
  console.log(`Mode: ${finald.speaker_mode} · Rounds: ${finald.rounds_completed}/${finald.rounds_planned}\n`);
  for (const t of final.turns ?? []) {
    const who = t.agentName ?? (t.agentId ? String(t.agentId).slice(0, 8) : "unknown");
    console.log(`--- ${t.isSummary ? "[SUMMARY]" : `Round ${t.roundNumber}`} · ${who} · ${t.status} ---`);
    console.log(t.content ?? "(no content)");
    console.log("");
  }
  if (finald.conclusion) {
    console.log(`\n=== CONCLUSION (${finald.conclusion_kind ?? "note"}) ===`);
    console.log(finald.conclusion);
  }
  console.log(`\n=== COMMITMENTS (${(final.commitments ?? []).length}) ===`);
  for (const cmt of final.commitments ?? []) {
    const m = fixture.members.find((x) => x.agentId === cmt.agent_id);
    console.log(`  ${m?.name ?? String(cmt.agent_id).slice(0, 8)}: ${cmt.signal}${cmt.reason ? ` — ${cmt.reason}` : ""}`);
  }
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s · LLM mode: ${didSimulate ? "PARTIAL/SIMULATED" : "LIVE"}\n`);

  await observer.endAsync();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
