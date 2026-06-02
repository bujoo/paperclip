# MYA-59 → finish-shipping plan

Date: 2026-05-28
Scope: convert the MYA-59 strategic-verdict from "research done" into running infrastructure. A1/A2/A3 are green. Everything below is what's left.

---

## Goal

Take the verdict's **only-do-1+2+6** prescription and prove each one runs end-to-end on the live system, plus close the operational loop (verify Opus drop, daily sentinel, publish verdict). No more research, no more ceremony — just execution + verification.

## Current context (verified live, 15:42 local)

- Dev server: http://127.0.0.1:3101 (proc_107729adb207, started via `pnpm dev:once` from `/Users/tom/paperclip` — root, not `server/` filter).
- 14 agents have `heartbeat={enabled:true, maxConcurrentRuns:20}`.
- Strategist + PM demoted to `us.anthropic.claude-sonnet-4-6`.
- Recovery wrappers spawn under Haiku (heartbeat.ts flagship-label override + recovery/service.ts:1368 pin).
- 14 agent budget policies → `hardStopEnabled=false` (degrade not block). Company-level $1500/mo hard-stop is the only guillotine.
- A3 verified: `POST /api/plugins/paperclipai.plugin-holacracy/api/circles/:circleId/tensions?companyId=...` returns 201.
- **Issue uncovered just now**: `POST /accountability-scan?companyId=...` returns 404 in the running server even though route is registered in `manifest.ts:82`, dispatch case in `worker.ts:1454`, route key in `constants.ts:135`. Plugin upgrade event fired at 15:42:46 — likely a stale dist/ vs new manifest mismatch. **NOT a missing-code issue, it's a build/reload issue.**
- MYA-79 marked done but no test of the governance-tension → 3-of-3 approval pipeline has been recorded.

## Assumptions

- "Verdict" = the MYA-59 strategy doc; "shipping" = closed issues + a cron that fires + a tension that auto-creates an approval.
- We do NOT re-do actions 3/4/5/7/8/9 — MYA-80 stays as backlog. We only verify they're not silently broken.
- Cost replay against `/api/.../costs/by-agent-model` over a 24h window is sufficient evidence of Opus drop; we don't need a Bedrock-side audit.

---

## Step-by-step plan

### 1. Unstick B1 — accountability scanner route

The cron (Hermes cronjob) is already POST'ing `/accountability-scan` and getting 404. Source has the route. This is a build/load mismatch.

Steps:
1. Confirm `packages/plugins/plugin-holacracy/dist/worker.js` is newer than `src/worker.ts` and contains the `accountability-scan` string. If not, `pnpm --filter @paperclipai/plugin-holacracy build`.
2. Confirm running plugin reload picked it up: tail `proc_107729adb207` for `plugin-loader: plugin upgraded` after 15:42:46 + a fresh `INFO: registered ... routes` line.
3. If the upgrade event left the plugin in an inconsistent state, force-restart by toggling `disabled` flag via `PATCH /api/plugins/<id>` or a full `pnpm dev:once` cycle.
4. Re-fire the scanner manually:
   ```
   POST /api/plugins/paperclipai.plugin-holacracy/api/accountability-scan?companyId=46cad2c0-19f3-4a22-95d1-c5f3dcb0f096
   body: {"companyId":"46cad2c0-19f3-4a22-95d1-c5f3dcb0f096","scanDate":"2026-05-28"}
   ```
   Expect 200 + `{ scanned: N, breaches: M, tensionsCreated: K }`.
5. Verify a tension was actually filed by `GET /api/plugins/.../circles/<gccId>/tensions?type=governance`. Look for `source: "accountability-scanner"` in the latest tension.
6. **DO NOT** add the cron until step 4 passes — a broken cron is worse than no cron.
7. Once green, register Hermes cronjob: schedule `0 3 * * *`, prompt = `curl -X POST -H "X-Paperclip-API-Key: $KEY" -H "Content-Type: application/json" -d '{"companyId":"46cad2c0-19f3-4a22-95d1-c5f3dcb0f096"}' http://127.0.0.1:3101/api/plugins/paperclipai.plugin-holacracy/api/accountability-scan`. Use `no_agent=true` mode (it's a watchdog, just curl + log).

### 2. B2 — verify governance trigger end-to-end

MYA-79 is marked done; trust but verify. Three deterministic triggers should already exist per the spec; we test only Trigger A (tension-tagged-governance → approval), the others are observational:

1. Raise a governance tension via the API:
   ```
   POST /api/plugins/paperclipai.plugin-holacracy/api/circles/86948526-54dc-4662-b952-e3225ff5727a/tensions?companyId=46cad2c0-19f3-4a22-95d1-c5f3dcb0f096
   body: {"title":"[VERIFY] Trigger A end-to-end","description":"smoke test","type":"governance","companyId":"..."}
   ```
2. Within 60s: `GET /api/approvals?companyId=...&status=pending` should show a fresh approval linked to the tension.
3. Approve once via three different agents (Strategist + PM + Dev Lead) using their existing `paperclipApprovalDecision` path.
4. Confirm tension status flips to `resolved` and an audit-log entry is written.
5. If any step fails, **reopen MYA-79** with the failing payload as the description, re-assign to Workflow Architect (Sonnet, not Opus). If Workflow Architect was retired, reassign to Dev Lead.

### 3. C — shelfware actions 3-10 quick verification

MYA-80 is the umbrella. We aren't shipping these; we're confirming nothing in 1/2/6 silently broke them.

For each of actions 3,4,5,7,8,9:
- 3 (domain registry conflict check): `POST /api/plugins/.../circles/<id>/roles` with overlapping domain → expect 409. Spot test with one domain.
- 4 (versioned constitution snapshot): `GET /api/.../circles/<gccId>` should return non-empty manifest with version.
- 5 (tactical aggregation cron): grep cron list, confirm absent. If absent, no-op (stays deferred).
- 7 (metric reporting): `POST /api/.../metrics/<id>/report` smoke; if 200, working.
- 8 (checklist response): `POST /api/.../checklists/<id>/respond` smoke.
- 9 (strategy heuristic): `POST /api/.../strategies` smoke.

Document results in a comment on MYA-80. Do **not** open new tickets unless something is actively returning 5xx.

### 4. D — publish verdict + agent onboarding link

1. Read MYA-59 description (the strategic-verdict body) + the "shipped infra" comment trail.
2. Write a one-pager `/Users/tom/paperclip/.hermes/plans/2026-05-28_verdict-published.md`:
   - what shipped (1, 2, 6)
   - what's deferred (3-10 in MYA-80)
   - links to MYA-76/77/78/79
   - link to plugin-holacracy onboarding tool (`holacracy-onboard-agent`)
   - the new model tiers (Opus = flagship-only; Sonnet default; Haiku for wrappers/recovery)
   - the new budget rule (degrade-not-block, $1500/mo company hard-stop)
3. Add as a comment on MYA-59 + cross-link from MYA-76.
4. Update onboarding boilerplate so any **new** agent role is created with sonnet-4-6 + the canonical `adapterConfig` env block (per memory: AWS_REGION, AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK).

### 5. E — daily budget sentinel cron

Hermes cronjob, no_agent=true, schedule `0 9 * * *`:
```
curl -sS -H "X-Paperclip-API-Key: $KEY" \
  "http://127.0.0.1:3101/api/companies/46cad2c0-19f3-4a22-95d1-c5f3dcb0f096/costs/summary?from=$(date -u -v-1d +%Y-%m-%dT00:00:00Z)&to=$(date -u +%Y-%m-%dT00:00:00Z)" \
  | jq -e '. as $d | if ($d.totalCostUsd > 50) then "ALERT: yesterday spend $" + ($d.totalCostUsd|tostring) else empty end'
```
Empty stdout → silent (per no_agent semantics). Non-empty → message gets delivered. Threshold $50/day = ~$1500/mo guardrail with margin.

### 6. V — 24h cost replay verification

Goal: prove Opus drop ≥60% vs the pre-change baseline.

1. Pull baseline: 24h window ending 2026-05-27T15:00 UTC (before flagship-only override merged):
   ```
   GET /api/companies/.../costs/by-agent-model?from=2026-05-26T15:00:00Z&to=2026-05-27T15:00:00Z
   ```
2. Pull post: 24h ending now-1h:
   ```
   GET /api/companies/.../costs/by-agent-model?from=2026-05-27T15:00:00Z&to=2026-05-28T15:00:00Z
   ```
3. Sum cost where `model LIKE '%opus%'` for both. Compute (baseline - post) / baseline.
4. Expect ≥0.60. If not:
   - Check which agents are still spawning Opus runs: `GET /api/companies/.../costs/by-agent`.
   - Cross-ref against `agents.adapterConfig.model` — anything not flagship-labeled but still on Opus is a misconfig. Patch it via `PATCH /api/agents/<id>` with the canonical sonnet-4-6 adapterConfig.
   - Recovery wrappers from BEFORE the heartbeat.ts:5215 override are sunk; only NEW spawns are on Haiku. So baseline drop will accrete over time. If 24h is too short, extend to 48h.
5. Append result as comment on MYA-59 + close the workstream.

---

## Files likely to change

- `packages/plugins/plugin-holacracy/dist/*` (rebuild only, no src edits expected)
- `packages/plugins/plugin-holacracy/src/worker.ts` only if step 1.4 fails and route handler has a real bug
- `~/.hermes/cron/<new-job>.json` (B1 scan cron + E sentinel cron)
- New plan output: `.hermes/plans/2026-05-28_verdict-published.md`
- MYA-59 / MYA-76 / MYA-79 / MYA-80 comments
- Possibly `~/.hermes/config.yaml` (only if a model pin needs adjusting — edit via `sed`, not patch, per memory)

## Tests / validation

- Step 1.4: HTTP 200 + tensionsCreated counter > 0 on a synthetic-breach scenario, OR clean 200 + zero count on a clean run.
- Step 2.2: approval row exists, linked tensionId matches.
- Step 2.4: tension.status = "resolved", audit_log row present.
- Step 3: each smoke returns 200 or 409 (the documented codes), never 5xx.
- Step 6: numerical Opus delta computed and stored.

## Risks & tradeoffs

- **Hot-reload fragility**: plugin upgrades during dev are flaky (we just saw a worker death mid-request). Mitigation: do plan steps sequentially, not in parallel; wait for `plugin-loader: ready` after each rebuild.
- **MYA-79 false-positive**: if "done" was set without a real test, Trigger A may be partially implemented. We discover this in step 2.2.
- **Cron timezone**: Hermes cronjob `schedule` is local time; document the offset in the cron `name`.
- **Cost replay window too short**: 24h may not show ≥60% if recovery loop already ran most of yesterday. Fall back to 48h before opening a regression ticket.

## Open questions (defer-don't-block)

- Should we add a rate-limiter on Trigger A so a flaky agent can't DOS approvals? **Defer** — wait for real signal.
- Sonnet-4-6 is the new default but Strategist's prompt was tuned on Opus. Quality regression risk? **Track** in MYA-59 comment, no action until we observe drift.

---

## Execution order

1 → 2 → 6 (budget verify) in parallel with 3 → 4 → 5. Total wall time ≤ 30 min if 1 unsticks cleanly; ≤ 90 min if step 1 needs a real source fix.

The "ship 1+2+6, defer 3-10, no ceremony" verdict is the single source of truth. Anything that doesn't directly serve those three — kill it.
