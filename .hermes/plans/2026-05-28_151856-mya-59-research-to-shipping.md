# MYA-59 — From Research to Shipping

**Status:** Research phase complete. Verdict written. Now: convert verdict into shipped infra.
**Pose-of-work:** "Constitution as code, governance as continuous deployment."
**Owner of plan:** Strategist (oversight) → delegates to Researcher / PM / Dev Lead.
**Created:** 2026-05-28

---

## 1. Goal

MYA-59 produced a strategic verdict on how a 14-agent Holacracy fleet should govern itself
without bleeding Opus tokens or running theatre meetings. The verdict identified ten candidate
actions; six are *anti-pattern* for an AI-native company (objection rounds, Lead-Link elections,
proposal-clarification rounds, sync agent meetings, etc.), and three are *load-bearing* (auto
accountability scan, governance-trigger codification, cost-tier degradation thermostat).

This plan ships only the load-bearing three, kills the shelfware, and proves the cost-rightsizing
delta with a 24-hour replay.

## 2. Current context / assumptions

- Paperclip dev server normally lives at `http://127.0.0.1:3101` under `pnpm dev:once` —
  currently DOWN as of plan time. Bring back up before any execution.
- `/Users/tom/paperclip` on `master`, uncommitted edits to:
  - `server/src/services/heartbeat.ts` (degradation block + flagship label override + activity log shape)
  - `server/src/services/recovery/service.ts` (Haiku pin + 6h/3-per-24h loop guard)
- TSC clean; `pnpm --filter @paperclipai/server build` green.
- 14 agents have heartbeat enabled. Strategist demoted to `us.anthropic.claude-sonnet-4-6`.
  Per-agent `hardStopEnabled=false`. Company circuit breaker $1500/mo.
- Recovery-wrapper spawns Haiku-4-5; 46 historical Opus wrappers already sunk.
- MYA-94 (`process_lost`) **resolved** — root cause was `tsx watch` reload reaping in-flight
  child runs; heartbeat startup-recovery branch already requeues them. Closed with comment.
- Open child issues: MYA-77 (action 1 — accountability table), MYA-78 (action 2 — scanner cron),
  MYA-79 (action 6 — governance triggers, currently `done` but trigger fires were failing),
  MYA-80 (deferred shelfware).
- Plugin-holacracy: `POST /tensions` returning 404. Workstream A3.

**Assumption:** the user has approved the deferral of actions 3, 4, 5, 7, 8, 9 to MYA-80
(shelfware backlog). This plan does not re-litigate.

## 3. Proposed approach

Five workstreams, A → E, each independently shippable. V is a verification gate.

```
A. Substrate fixes        (server uptime, plugin endpoint, build hygiene)
B. Verdict actions        (B1 scanner cron, B2 governance triggers)
C. Shelfware verification (confirm 3/4/5/7/8/9 stay deferred, log rationale)
D. Publish                (verdict + onboarding doc to Operations & R&D)
E. Daily sentinel         (cron pinging budget overview, alerts on tier degradation)
V. 24h cost replay        (must show ≥60% Opus token-spend drop vs prior 24h)
```

A and B are blocking; C/D/E parallelise; V gates the close-out.

## 4. Step-by-step plan

### A — Substrate fixes (do first, sequential)

**A1 — server back up (BLOCKED RIGHT NOW)**
- `cd /Users/tom/paperclip && pnpm --filter @paperclipai/server dev:once`
- Wait for `200` on `/api/health`.
- Verify embedded postgres `pid` and dev server pid via `ps -ef | grep tsx`.

**A2 — `process_lost` regression test**
- Already closed MYA-94. Add a regression assertion: in
  `server/src/__tests__/heartbeat-process-recovery.test.ts`, ensure a `process_lost`
  outside the startup window populates `resultJson.errorMessage` and `errorCode`.
- Run `pnpm --filter @paperclipai/server test heartbeat-process-recovery`.

**A3 — plugin-holacracy `POST /tensions` 404**
- Files to inspect: `packages/plugins/plugin-holacracy/src/manifest.ts`,
  `packages/plugins/plugin-holacracy/src/worker.ts`,
  `packages/plugins/plugin-holacracy/src/governance-trigger.test.ts`.
- Likely cause: route is registered with a scope/namespace prefix that the caller is not
  using. The earlier mcp-manager fix (`useHostContext().companyPrefix`) hints the same
  pattern: hardcoded `CH` somewhere where it should be the dynamic prefix.
- Reproducer:
  ```
  curl -sS -X POST http://127.0.0.1:3101/api/plugins/<holacracy-plugin-id>/tensions \
       -H "X-Paperclip-API-Key: $KEY" \
       -H "Content-Type: application/json" \
       -d '{"circleId":"...","title":"...","description":"...","type":"operational"}'
  ```
- Fix: replace any literal `CH` prefix or fixed namespace with the host context's
  `companyPrefix` (mirror of mcp-manager fix).
- Rebuild: `pnpm --filter plugin-holacracy build`. Restart dev server.
- Smoke test: re-fire the curl above and a `mcp_paperclip_paperclipApiRequest`.

### B — Verdict actions (parallel after A1)

**B1 — Nightly accountability scanner cron (MYA-78)**
- Dev Lead is already executing this issue (run `b973e72c`).
- This plan's role: **monitor + accept handoff**, not re-implement.
- Acceptance:
  1. Cron file lives at `~/paperclip/packages/scheduler/jobs/accountability-scan.ts`
     OR a Hermes cronjob that calls Paperclip API directly (either is fine).
  2. Runs daily 03:00 local.
  3. For every agent × every accountability with `cadence ∈ {due_now}`, evaluates the
     metric and, on breach of `alert_threshold`, files a tension via
     `paperclipRaiseTension` with structured payload:
     `{agent_id, accountability_name, metric_value, threshold, cadence, observed_at}`.
  4. Dry-run flag (`PAPERCLIP_SCANNER_DRYRUN=1`) for staging.
  5. End-to-end test: seed one agent with a deliberately-breached accountability,
     run scanner, assert one new tension exists.

**B2 — Governance trigger codification (MYA-79)**
- MYA-79 was marked `done` but had 12 trigger failures. Reopen if the failures are still
  unaddressed. Two triggers must be live:
  - **Trigger 1:** any role with cumulative `billed_cents > 0.8 × budget_cap` for current
    calendar month → file governance tension on the role's circle.
  - **Trigger 2:** any agent with three consecutive `failed` runs of any kind → file
    operational tension on its circle, route to assignee = Lead Link of that circle.
- Async 3-of-3 approval gate: Strategist + PM + Dev Lead must each approve before tension
  is acted on. Async = no meeting; comment-based.
- Files: same plugin-holacracy package. Likely `governance-trigger.ts` already exists per
  the test file naming.
- Acceptance: trigger a deliberate breach in staging, see exactly one tension filed,
  see three approval prompts created, all addressable via API.

### C — Shelfware verification (parallel)

For each of actions 3, 4, 5, 7, 8, 9 (deferred under MYA-80):
- Locate the rationale comment on MYA-59 / MYA-80.
- If missing, write a one-paragraph "why deferred for AI-native fleet" rationale and
  attach as a comment on MYA-80.
- Tag MYA-80 with `shelfware` label.
- Confirm no scheduler job, plugin route, or agent accountability silently re-introduces
  the shelfware behaviour (`grep` for action keywords).

Output: a single comment on MYA-80 with a 6-row table {action, why deferred, would-cost-if-shipped}.

### D — Publish verdict + agent onboarding

**D1 — Verdict doc**
- Render the MYA-59 verdict as a markdown doc (use existing description + final comment).
- Write to `~/paperclip/docs/governance/2026-05-28-mya-59-verdict.md`.
- Headline: "Constitution as code, governance as continuous deployment."

**D2 — Agent onboarding link**
- Update each agent's `capabilities` field to reference the verdict doc URL (file:// or
  Tailscale URL).
- Use `mcp_paperclip_paperclipApiRequest("PATCH", "/api/agents/<id>", {capabilities: ...})`
  in a loop over the 14 agents. Append, do not overwrite.

**D3 — Telegram broadcast**
- One terse message to Operations topic 23 and R&D topic 35 in the Hermes group:
  "MYA-59 closed. Verdict doc: <link>. Three actions live (accountability scan, governance
  triggers, cost thermostat). Six deferred — see MYA-80."

### E — Daily budget sentinel cron

- Create Hermes cronjob (`cronjob action=create`):
  - schedule: `0 9 * * *` (daily 09:00 local, before workday start)
  - prompt: "Fetch `/api/budgets/overview`. For each policy where
    `observedAmount / amount > 0.7`, post a comment on the agent's primary circle
    naming the agent, percentage, and tier-degradation status. If
    `companyHardStopReached=true`, post CRITICAL alert."
  - deliver: `origin,all` so it lands in the Telegram group too.
  - enabled_toolsets: `["web", "terminal"]`.
- Acceptance: run job manually once via `cronjob action=run`, see at least one expected
  warning or "all clear" message.

### V — 24h cost replay (gate)

- Pull `cost_events` from postgres for the 24h preceding the heartbeat patch deploy.
- Pull `cost_events` for the 24h after deploy.
- Compute Opus-token spend per window. Required: ≥ 60% drop.
- If < 60%, do not close MYA-59; open a child issue identifying which agent/run is still
  on Opus and why.

Query template (run via Paperclip API not psql, since psql isn't in PATH):
```
GET /api/cost-events?windowStart=<iso>&windowEnd=<iso>&model=*opus*
```

## 5. Files likely to change

| File | Change | Workstream |
|------|--------|------------|
| `packages/plugins/plugin-holacracy/src/worker.ts` (or `manifest.ts`) | replace hardcoded `CH` w/ `companyPrefix` | A3 |
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | regression assertion on `process_lost` errorCode | A2 |
| `packages/scheduler/jobs/accountability-scan.ts` (NEW) | scanner cron implementation | B1 |
| `packages/plugins/plugin-holacracy/src/governance-trigger.ts` | two triggers + 3-of-3 approval | B2 |
| `docs/governance/2026-05-28-mya-59-verdict.md` (NEW) | verdict doc | D1 |
| Hermes cron registry (`~/.hermes/cron/`) | daily budget sentinel | E |

No changes to `~/.hermes/config.yaml` are planned (already patched in earlier turn).

## 6. Tests / validation

- `pnpm --filter @paperclipai/server test` (heartbeat regression)
- `pnpm --filter plugin-holacracy test` (accountability + governance trigger units)
- Manual smoke for each new endpoint via `curl` + `mcp_paperclip_paperclipApiRequest`
- 24-hour cost replay (the V gate)
- Telegram broadcast lands in both topics

## 7. Risks, tradeoffs, open questions

**Risks**
- B1 scanner could file tension storms if multiple accountabilities breach the same hour.
  Mitigation: dedupe by `(agent_id, accountability_name, calendar_day)` before raising.
- B2 governance trigger 3-of-3 approval gate could deadlock if Strategist is on cooldown
  due to budget degradation. Mitigation: approval gate falls back to 2-of-3 with PM + Dev
  Lead after 12h.
- D2 mass-update of all 14 agent `capabilities` fields could clobber if `PATCH` overwrites.
  Mitigation: read-modify-write with optimistic concurrency token if the API exposes one,
  else read full record, append, write back, verify diff.
- V replay could under-count cached Opus calls. Mitigation: use `inputTokens + outputTokens`
  not `billed_cents` for the percentage drop calc.

**Tradeoffs**
- Deferring actions 3/4/5/7/8/9 to MYA-80 means a future human reviewer might re-litigate.
  Accept the cost; rationale doc on MYA-80 is the bulwark.
- 09:00 daily sentinel runs *after* the 03:00 scanner. Means up to 6h of latent breaches
  before a human sees them in Telegram. Acceptable for v1.

**Open questions**
1. Is plugin-holacracy `POST /tensions` 404 actually the `companyPrefix` bug, or a
   missing route registration? Fast to verify once A1 is up.
2. Should the V gate's "60% drop" be on token count, billed cents, or run count?
   I assumed input+output tokens. Confirm before claiming victory.
3. Does the user want the Telegram broadcast (D3) auto-fired, or held until they ack the
   verdict doc? Defaulting to auto-fire.

---

## Resume order if interrupted again

1. A1 (server up) — blocking everything else
2. A3 (404 fix) — sub-15min, unblocks B2 verification
3. B1 (let Dev Lead finish, then accept) — already in flight
4. B2 (verify triggers fire, fix if not)
5. C (single comment on MYA-80)
6. D1 → D2 → D3 (docs then broadcast)
7. E (cron create + run once)
8. V (24h replay; only run after at least 24h post-A1 deploy)
