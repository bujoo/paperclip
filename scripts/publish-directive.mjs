#!/usr/bin/env node
// Phase 1.17 — Publish a company-wide directive over A2A-MQTT.
//
// Usage:
//   node scripts/publish-directive.mjs <kind> [--scope lead_links] [--company <uuid>]
//   node scripts/publish-directive.mjs plan-routines
//   node scripts/publish-directive.mjs plan-goals
//
// One MQTT publish on `$a2a/v1/directive/{companyId}` triggers the server
// to materialise ONE issue per recipient (resolved by scope) and assign it
// to that recipient. The agent wakes via the normal issue.assigned path
// and uses the bundled skill that matches the directive body.

import { connectAsync } from "/Users/tom/paperclip/node_modules/mqtt/build/index.js";
import { config as loadDotenv } from "/Users/tom/paperclip/node_modules/.pnpm/dotenv@17.3.1/node_modules/dotenv/lib/main.js";

loadDotenv({ path: "/Users/tom/paperclip/.env", quiet: true });

const args = process.argv.slice(2);
const kind = args.shift();
if (!kind) {
  console.error("usage: node scripts/publish-directive.mjs <kind> [--scope lead_links] [--company <uuid>]");
  console.error("kinds: plan-routines, plan-goals");
  process.exit(1);
}

let scope = "lead_links";
let companyId = "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096"; // ContextHub
while (args.length) {
  const a = args.shift();
  if (a === "--scope") scope = args.shift();
  else if (a === "--company") companyId = args.shift();
  else {
    console.error(`unknown arg: ${a}`);
    process.exit(1);
  }
}

const bodies = {
  "plan-routines": "Plan your circle's recurring meeting routines now.",
  "plan-goals": "Define this quarter's circle goals now.",
};
const body = bodies[kind] ?? `Directive: ${kind}`;

const topic = `$a2a/v1/directive/${companyId}`;
const payload = JSON.stringify({ kind, body, scope });

console.log(`Publishing directive:`);
console.log(`  broker:  mqtt://127.0.0.1:1883`);
console.log(`  topic:   ${topic}`);
console.log(`  payload: ${payload}`);
console.log();

// Use the local-dev anonymous publish path or the internal secret.
// In local dev EMQX accepts the host:paperclip-server username with the
// configured PAPERCLIP_MQTT_HOST_PASSWORD (or anonymous when allowed).
const hostPassword =
  process.env.PAPERCLIP_MQTT_HOST_PASSWORD ??
  process.env.PAPERCLIP_MQTT_INTERNAL_SECRET ??
  "local-trusted-key";

const client = await connectAsync("mqtt://127.0.0.1:1883", {
  protocolVersion: 5,
  clientId: `paperclip-directive-cli-${Date.now()}`,
  username: "host:paperclip-server",
  password: hostPassword,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 5000,
});

await client.publishAsync(topic, payload, {
  qos: 1,
  retain: false,
  properties: {
    contentType: "application/json",
    userProperties: {
      "a2a-directive-kind": kind,
      "publishedBy": "paperclip-directive-cli",
    },
  },
});

console.log("✓ Published.");
console.log();
console.log("Watch:");
console.log(`  grep -E "directive|a2a-directive" /tmp/paperclip-dev.log | tail -10`);
console.log(`  # Within 30s: N new issues (origin_kind='a2a:directive') appear`);
console.log(`  # Within 5 min: each recipient's agent run uses the matching skill`);

await client.endAsync();
process.exit(0);
