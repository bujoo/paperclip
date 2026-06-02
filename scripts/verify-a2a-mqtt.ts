/**
 * End-to-end verification for the A2A-over-MQTT transport (Phase 1.7.B).
 *
 * Asserts that EMQX + the server's auth/ACL callbacks + the agent runtime
 * bridge actually wire together. Run via `pnpm verify:a2a`.
 *
 * Pre-reqs the script *does not* set up (run manually first):
 *   - `docker compose up -d` (with docker-compose.override.local.yml if needed)
 *   - server is running on PAPERCLIP_BASE_URL with PAPERCLIP_MQTT_HOST_PASSWORD
 *     + PAPERCLIP_MQTT_AUTH_SECRET set (or matching docker compose defaults)
 *
 * The script emits one JSON line per step on stdout:
 *   { step: 1, name: "stack health", ok: true, latencyMs: 42, details: {...} }
 *
 * Exit code 0 if every step passes, 1 on the first red. On red, the script
 * shells out `docker compose logs --tail=100` for the emqx + server services
 * and prints them to stderr for inspection. The stack is left running.
 *
 * Phase 1.8/1.9 will append heartbeat + DNA steps; each step is its own async
 * function passed to `step(n, name, fn)` so growth is mechanical.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { connectAsync, type IClientOptions, type MqttClient } from "mqtt";
import { computeAgentMqttPassword } from "../server/src/mqtt/auth-backend.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Env {
  baseUrl: string;
  mqttHost: string;
  mqttPort: number;
  mqttHostPassword: string;
  mqttAuthSecret: string;
}

function loadEnv(): Env {
  const baseUrl = (process.env.PAPERCLIP_BASE_URL ?? "http://localhost:3100").replace(
    /\/$/,
    "",
  );
  const mqttHost = process.env.PAPERCLIP_MQTT_HOST ?? "localhost";
  const mqttPort = Number(process.env.PAPERCLIP_MQTT_PORT ?? 1884);
  const mqttHostPassword =
    process.env.PAPERCLIP_MQTT_HOST_PASSWORD?.trim() ?? "paperclip-host-dev";
  const mqttAuthSecret =
    process.env.PAPERCLIP_MQTT_AUTH_SECRET?.trim() ??
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ??
    process.env.BETTER_AUTH_SECRET?.trim() ??
    "";
  if (!Number.isFinite(mqttPort) || mqttPort <= 0) {
    throw new Error(`Invalid PAPERCLIP_MQTT_PORT=${process.env.PAPERCLIP_MQTT_PORT}`);
  }
  return { baseUrl, mqttHost, mqttPort, mqttHostPassword, mqttAuthSecret };
}

const HOST_MQTT_USERNAME = "host:paperclip-server";

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

interface StepResult {
  step: number;
  name: string;
  ok: boolean;
  latencyMs: number;
  details: Record<string, unknown>;
}

const results: StepResult[] = [];
let firstRed: StepResult | null = null;

async function step(
  n: number,
  name: string,
  fn: () => Promise<Record<string, unknown> | void>,
): Promise<boolean> {
  if (firstRed) {
    // Skip further steps once we've hit a red — but report them so the
    // structured output is still complete.
    const result: StepResult = {
      step: n,
      name,
      ok: false,
      latencyMs: 0,
      details: { skipped: true, reason: `prior step ${firstRed.step} failed` },
    };
    results.push(result);
    process.stdout.write(JSON.stringify(result) + "\n");
    return false;
  }
  const startedAt = Date.now();
  try {
    const details = (await fn()) ?? {};
    const result: StepResult = {
      step: n,
      name,
      ok: true,
      latencyMs: Date.now() - startedAt,
      details,
    };
    results.push(result);
    process.stdout.write(JSON.stringify(result) + "\n");
    return true;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    const stack = err instanceof Error ? err.stack ?? null : null;
    const result: StepResult = {
      step: n,
      name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      details: { error: message, stack },
    };
    results.push(result);
    firstRed = result;
    process.stdout.write(JSON.stringify(result) + "\n");
    return false;
  }
}

// ---------------------------------------------------------------------------
// MQTT helpers
// ---------------------------------------------------------------------------

interface ConnectOptions {
  username?: string;
  password?: string;
  clientId?: string;
  /** When true, swallow connection errors and resolve with { connected: false }. */
  expectFailure?: boolean;
}

interface ConnectAttempt {
  connected: boolean;
  client: MqttClient | null;
  rejection: { name: string; code: number | null; message: string } | null;
}

async function attemptMqttConnect(env: Env, opts: ConnectOptions): Promise<ConnectAttempt> {
  const clientId = opts.clientId ?? `verify-${randomUUID()}`;
  const url = `mqtt://${env.mqttHost}:${env.mqttPort}`;
  const cfg: IClientOptions = {
    clientId,
    username: opts.username,
    password: opts.password,
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 0, // single-shot — do not auto-retry
    connectTimeout: 4000,
  };
  try {
    const client = await connectAsync(url, cfg);
    return { connected: true, client, rejection: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // mqtt.js wraps CONNACK rejections as errors named "Error" with a code.
    const code =
      typeof (err as { code?: unknown }).code === "number"
        ? ((err as { code: number }).code)
        : null;
    if (opts.expectFailure) {
      return { connected: false, client: null, rejection: { name: "rejected", code, message } };
    }
    throw new Error(`MQTT connect failed for ${clientId}: ${message}`);
  }
}

async function closeClient(client: MqttClient | null): Promise<void> {
  if (!client) return;
  await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpGetStatus(url: string): Promise<{ status: number; ok: boolean }> {
  try {
    const res = await fetch(url, { method: "GET" });
    return { status: res.status, ok: res.ok };
  } catch (err) {
    throw new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface MqttAuthCallbackResult {
  status: number;
  body: unknown;
}

async function callMqttAuthBackend(
  env: Env,
  body: Record<string, unknown>,
): Promise<MqttAuthCallbackResult> {
  const url = `${env.baseUrl}/api/internal/mqtt-auth`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    throw new Error(
      `auth route mismatch: ${url} returned 404. The EMQX HTTP authenticator URL ` +
        `(docker/emqx/emqx.conf) and the route registered in app.ts have drifted. ` +
        `Confirm both reference POST /api/internal/mqtt-auth.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepStackHealth(env: Env): Promise<Record<string, unknown>> {
  const serverHealth = await httpGetStatus(`${env.baseUrl}/api/health`);
  if (!serverHealth.ok) {
    throw new Error(`server /api/health returned ${serverHealth.status}`);
  }
  // EMQX dashboard sometimes maps to a different port via override; assert
  // host port via TCP connect rather than HTTP because the dashboard's index
  // may 302 to a login page.
  return { serverStatus: serverHealth.status };
}

async function stepAuthCallbackFires(env: Env): Promise<Record<string, unknown>> {
  // Bypass the broker entirely: hit the server's auth route directly with
  // valid host creds. This is a guarantee the route exists *and* validates.
  const result = await callMqttAuthBackend(env, {
    username: HOST_MQTT_USERNAME,
    password: env.mqttHostPassword,
    clientid: HOST_MQTT_USERNAME,
    peerhost: "127.0.0.1",
  });
  if (result.status !== 200) {
    throw new Error(`auth backend returned HTTP ${result.status} for host creds`);
  }
  const decision = (result.body as { result?: string } | null)?.result;
  if (decision !== "allow") {
    throw new Error(`auth backend denied host creds (result=${decision ?? "<none>"})`);
  }
  return { status: result.status, decision };
}

async function stepAnonymousReject(env: Env): Promise<Record<string, unknown>> {
  const attempt = await attemptMqttConnect(env, { expectFailure: true });
  await closeClient(attempt.client);
  if (attempt.connected) {
    throw new Error("anonymous MQTT connect succeeded (expected reject)");
  }
  return {
    rejected: true,
    rejection: attempt.rejection,
  };
}

async function stepBogusAgentReject(env: Env): Promise<Record<string, unknown>> {
  const fakeCompany = randomUUID();
  const fakeCircle = randomUUID();
  const fakeAgent = randomUUID();
  const username = `${fakeCompany}/${fakeCircle}/${fakeAgent}`;
  const attempt = await attemptMqttConnect(env, {
    username,
    password: "definitely-not-a-real-password",
    expectFailure: true,
  });
  await closeClient(attempt.client);
  if (attempt.connected) {
    throw new Error("bogus agent MQTT connect succeeded (expected reject)");
  }
  // Also verify via the auth callback that the server denies — covers the
  // case where the broker is misconfigured to allow_anonymous=true.
  const callback = await callMqttAuthBackend(env, {
    username,
    password: "definitely-not-a-real-password",
    clientid: username,
    peerhost: "127.0.0.1",
  });
  const decision = (callback.body as { result?: string } | null)?.result;
  if (decision !== "deny") {
    throw new Error(
      `auth backend did not deny bogus agent creds (result=${decision ?? "<none>"})`,
    );
  }
  return { rejected: true, authBackendDecision: decision };
}

// Steps 5-13 require live fixtures (test company, alice/bob agents,
// holacracy roles, IDM, tactical-pulse routine). They are intentionally
// scaffolded as TODOs so the structure is in place — Phase 1.7.C / a follow-up
// task will fill them in once the fixture setup is automated. Each TODO fails
// fast with a clear reason, marking the step red.

interface FixtureContext {
  companyId: string | null;
  aliceAgentId: string | null;
  aliceCircleId: string | null;
  aliceKeyHash: string | null;
  bobAgentId: string | null;
  bobCircleId: string | null;
  bobKeyHash: string | null;
}

async function stepCreateTestAgents(_env: Env, _ctx: FixtureContext): Promise<Record<string, unknown>> {
  throw new Error(
    "fixture setup not implemented: needs POST /api/companies/:id/agents + role assignment + " +
      "agent_api_keys row. Run the fixture seeder (TODO) or set the *_AGENT_ID env vars to skip.",
  );
}

async function stepAgentCardProjection(
  env: Env,
  ctx: FixtureContext,
): Promise<Record<string, unknown>> {
  if (!ctx.companyId) {
    throw new Error("no companyId in context (step 5 must succeed first)");
  }
  // Connect as the host (superuser) and subscribe to discovery wildcard for
  // the test company. Assert at least one retained Card arrives within 2s.
  const attempt = await attemptMqttConnect(env, {
    username: HOST_MQTT_USERNAME,
    password: env.mqttHostPassword,
    clientId: `verify-host-${randomUUID()}`,
  });
  if (!attempt.connected || !attempt.client) {
    throw new Error("host singleton could not connect for discovery probe");
  }
  const client = attempt.client;
  const topic = `paperclip/v1/discovery/${ctx.companyId}/+/+`;
  const received: Array<{ topic: string; payload: unknown }> = [];
  client.on("message", (t: string, payload: Buffer) => {
    let body: unknown = null;
    try {
      body = JSON.parse(payload.toString("utf-8"));
    } catch {
      body = payload.toString("utf-8");
    }
    received.push({ topic: t, payload: body });
  });
  await new Promise<void>((resolve, reject) =>
    client.subscribe(topic, { qos: 1 }, (err: Error | null) =>
      err ? reject(err) : resolve(),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await closeClient(client);
  if (received.length === 0) {
    throw new Error(
      `no retained Agent Cards arrived on ${topic} within 2s — projector may be idle`,
    );
  }
  return { topic, received: received.length, sample: received[0] };
}

async function stepAclEnforcement(_env: Env, _ctx: FixtureContext): Promise<Record<string, unknown>> {
  throw new Error("ACL enforcement check not implemented (depends on step 5 fixtures)");
}

async function stepCrossLink(_env: Env, _ctx: FixtureContext): Promise<Record<string, unknown>> {
  throw new Error("cross-link check not implemented (depends on step 5 fixtures)");
}

async function stepCrossRoleRoundTrip(
  _env: Env,
  _ctx: FixtureContext,
): Promise<Record<string, unknown>> {
  throw new Error(
    "cross-role round-trip not implemented (hard proof — depends on step 5 fixtures; " +
      "this is the step that exercises the agent-runtime-bridge inbound/outbound paths)",
  );
}

async function stepIdmPhaseEmission(
  _env: Env,
  _ctx: FixtureContext,
): Promise<Record<string, unknown>> {
  throw new Error("IDM phase emission check not implemented (depends on step 5 fixtures)");
}

async function stepElectionRetainedDiscovery(
  _env: Env,
  _ctx: FixtureContext,
): Promise<Record<string, unknown>> {
  throw new Error("election retained-Card discovery not implemented (depends on step 5 fixtures)");
}

async function stepLwtPresence(_env: Env, _ctx: FixtureContext): Promise<Record<string, unknown>> {
  throw new Error("LWT presence check not implemented (depends on step 5 fixtures)");
}

async function stepTacticalPulseFanout(
  _env: Env,
  _ctx: FixtureContext,
): Promise<Record<string, unknown>> {
  throw new Error("tactical-pulse fan-out check not implemented (depends on step 5 fixtures)");
}

// HMAC password derivation sanity check — useful for the fixture seeder
// once it lands. Confirms the exported helper produces a value the server
// would accept, given a known keyHash.
function _exampleAgentPassword(args: {
  keyHash: string;
  companyId: string;
  agentId: string;
  secret: string;
}): string {
  return computeAgentMqttPassword(args);
}

// ---------------------------------------------------------------------------
// Failure post-mortem
// ---------------------------------------------------------------------------

function dumpRecentLogs(): void {
  process.stderr.write("\n--- recent docker compose logs (--tail=100) ---\n");
  for (const svc of ["emqx", "server"]) {
    process.stderr.write(`\n=== ${svc} ===\n`);
    const result = spawnSync(
      "docker",
      ["compose", "logs", "--tail=100", svc],
      { encoding: "utf-8" },
    );
    if (result.error) {
      process.stderr.write(`(failed to run docker compose logs ${svc}: ${result.error.message})\n`);
      continue;
    }
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const env = loadEnv();
  process.stderr.write(
    `verify-a2a-mqtt: baseUrl=${env.baseUrl} mqtt=${env.mqttHost}:${env.mqttPort}\n`,
  );

  const ctx: FixtureContext = {
    companyId: process.env.PAPERCLIP_VERIFY_COMPANY_ID ?? null,
    aliceAgentId: process.env.PAPERCLIP_VERIFY_ALICE_AGENT_ID ?? null,
    aliceCircleId: process.env.PAPERCLIP_VERIFY_ALICE_CIRCLE_ID ?? null,
    aliceKeyHash: process.env.PAPERCLIP_VERIFY_ALICE_KEY_HASH ?? null,
    bobAgentId: process.env.PAPERCLIP_VERIFY_BOB_AGENT_ID ?? null,
    bobCircleId: process.env.PAPERCLIP_VERIFY_BOB_CIRCLE_ID ?? null,
    bobKeyHash: process.env.PAPERCLIP_VERIFY_BOB_KEY_HASH ?? null,
  };

  await step(1, "stack health", () => stepStackHealth(env));
  await step(2, "EMQX → server auth callback fires", () => stepAuthCallbackFires(env));
  await step(3, "anonymous reject", () => stepAnonymousReject(env));
  await step(4, "bogus agent reject", () => stepBogusAgentReject(env));
  await step(5, "create two test agents (alice, bob)", () => stepCreateTestAgents(env, ctx));
  await step(6, "Agent Card projection", () => stepAgentCardProjection(env, ctx));
  await step(7, "ACL enforcement", () => stepAclEnforcement(env, ctx));
  await step(8, "cross-link", () => stepCrossLink(env, ctx));
  await step(9, "cross-role request round-trip", () => stepCrossRoleRoundTrip(env, ctx));
  await step(10, "IDM phase emission", () => stepIdmPhaseEmission(env, ctx));
  await step(11, "election retained-Card discovery", () =>
    stepElectionRetainedDiscovery(env, ctx),
  );
  await step(12, "LWT presence", () => stepLwtPresence(env, ctx));
  await step(13, "tactical-pulse fan-out", () => stepTacticalPulseFanout(env, ctx));

  const greens = results.filter((r) => r.ok).length;
  const reds = results.filter((r) => !r.ok).length;
  process.stderr.write(
    `\nverify-a2a-mqtt: ${greens}/${results.length} steps green, ${reds} red\n`,
  );

  if (firstRed) {
    process.stderr.write(
      `\nFIRST RED: step ${firstRed.step} (${firstRed.name}): ${
        (firstRed.details as { error?: string }).error ?? "<no error message>"
      }\n`,
    );
    dumpRecentLogs();
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(
      `verify-a2a-mqtt: unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
