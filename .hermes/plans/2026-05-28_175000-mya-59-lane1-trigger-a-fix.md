# MYA-59 Lane 1 — Trigger A fix + V replay

Plan-of-record: finish Phase 1 of `/Users/tom/.hermes/plans/2026-05-28_122600-mya-59-closeout-v2.md`. This file replaces the open question marks in B2 with a concrete fix.

## Goal

Make governance tensions auto-create 3-of-3 board approvals end-to-end (B2 task), then run the 24h cost replay (V task) to confirm Lane-1 is shippable.

## Root cause (confirmed live, not theorized)

Reproduced via direct REST: POST `/api/plugins/paperclipai.plugin-holacracy/api/circles/:circleId/tensions` with `type:"governance"` returns 201 with the tension but no `approvalId`. Audit log shows only `tension-raised`, no `governance-approval-created`. Manual approval POST to `/api/companies/:companyId/approvals` with the helper's exact payload returns 201 fine.

Therefore the bug is in `createGovernanceApproval` (`packages/plugins/plugin-holacracy/src/worker.ts:216`). It uses `httpCtx.fetch` (SDK-proxied via `http.fetch`). The host implementation in `server/src/services/plugin-host-services.ts:127-191` (`validateAndResolveFetchUrl`):

- Resolves `localhost` → `127.0.0.1`
- Filters out all private IPs: `safeResults = results.filter((entry) => !isPrivateIP(entry.address))`
- Throws `All resolved IPs for localhost are in private/reserved ranges`

The helper's `try/catch` swallows this, returns `undefined`, the route responds 201 without `approvalId`, no audit row is written. SSRF guard is doing exactly what it's designed to do — block plugin code from reaching loopback. The fix has to route around it, not relax it.

## Approach

Add a first-class SDK capability `approvals.create` to `plugin-host-services.ts`. It calls the internal approvals service directly (no HTTP, no SSRF guard, no ports). Helper switches from `httpCtx.fetch(...)` to `ctx.approvals.create(...)`. Same payload shape, same DB write, same audit. Cleaner than punching loopback holes and reusable for any future plugin trigger.

Fallback if scope explodes: gate a `loopback bypass` only for `paperclipai.plugin-holacracy` via a manifest opt-in. Not preferred — it grants a lasting privilege escalation just to fix one helper.

## Step-by-step

1. **Find the existing approvals service.** `server/src/routes/approvals.ts` already implements POST handler. Extract a service function `createApprovalDirect({ companyId, payload, type, requestedByAgentId })` if it isn't already in `server/src/services/approvals-service.ts`. Keep route handler as a thin wrapper.

2. **Add SDK capability.**
   - `packages/plugins/sdk/src/protocol.ts`: register `approvals.create` method types.
   - `packages/plugins/sdk/src/host-client-factory.ts`: add `approvals.create` to `gated()` table, mapped to a new capability string `approvals.create`.
   - `packages/plugins/sdk/src/types.ts`: extend the public `ctx.approvals` interface.
   - `packages/plugins/sdk/src/worker-rpc-host.ts`: add `approvals` namespace alongside `http`, `db`, etc., calling `callHost("approvals.create", ...)`.

3. **Wire host implementation.** In `server/src/services/plugin-host-services.ts`, add `approvals: { async create(params) { ... } }` next to `http: {...}`. Body: validate `companyId`, call `createApprovalDirect`, return `{ approvalId }`.

4. **Declare capability in plugin manifest.** `packages/plugins/plugin-holacracy/src/manifest.ts:31-40`: add `"approvals.create"` to the `capabilities` array.

5. **Replace helper.** In `packages/plugins/plugin-holacracy/src/worker.ts:216-262`, swap `fetchFn(...)` block for `ctx.approvals.create({...})`. Drop `apiBase` param. Keep the same try/catch-with-log shape so failures still surface.

6. **Build chain (in order):**
   - `pnpm --filter @paperclipai/sdk build`
   - `pnpm --filter @paperclipai/plugin-holacracy build`
   - Server picks up SDK changes via project refs, but verify: `pnpm --filter @paperclipai/server build`
   - Restart dev server: `pnpm dev:once` from `/Users/tom/paperclip` (NOT tsx-watch).

7. **Re-run B2 verification (live):**
   - POST a governance tension via REST.
   - Assert response includes `approvalId`.
   - Poll `/api/companies/:companyId/approvals?status=pending` and confirm the new tension's id is in `payload.governance_proposal.tension_id` and approver_agent_ids = [Strategist, PM, Dev Lead].
   - Confirm `governance-approval-created` row in the circle audit log.

8. **Run V (24h cost replay).**
   - Pull cost_events for past 24h via API.
   - Compute Opus share before vs after the Sonnet pin commit.
   - Target: ≥60% Opus drop.
   - Save the report under `.hermes/plans/2026-05-28_v-cost-replay.md` or attach to MYA-59 disposition doc.

9. **Update MYA-59 disposition doc** with B2 ✅ and V verdict, then close MYA-59.

## Files likely to change

- `server/src/services/plugin-host-services.ts` (+ `approvals: {...}` block)
- `server/src/services/approvals-service.ts` (new, or extracted from routes/approvals.ts)
- `server/src/routes/approvals.ts` (delegate to service)
- `packages/plugins/sdk/src/protocol.ts` (+ method type)
- `packages/plugins/sdk/src/host-client-factory.ts` (+ gated entry, capability map)
- `packages/plugins/sdk/src/types.ts` (+ `ctx.approvals` public type)
- `packages/plugins/sdk/src/worker-rpc-host.ts` (+ `approvals` namespace)
- `packages/plugins/plugin-holacracy/src/manifest.ts` (+ capability)
- `packages/plugins/plugin-holacracy/src/worker.ts:216-262` (rewrite helper)

## Tests / validation

- Unit: nothing strictly required — the SDK capability is a thin proxy. Add one if `approvals-service.ts` is newly extracted.
- Integration: existing `packages/plugins/plugin-holacracy/src/governance-trigger.test.ts` is the canonical guard for this trigger. Run it after the swap. If it stubs `httpCtx.fetch`, switch the stub to `ctx.approvals.create`.
- Live smoke: step 7 above.
- Regression: ensure existing `/api/companies/:companyId/approvals` POST route still works (ALREADY VERIFIED working — keep that path stable).

## Risks / tradeoffs

- Adding an SDK capability is a small surface-area expansion of the plugin contract. Low blast radius — `approvals.create` is well-scoped and gated.
- Worker test file may stub `httpCtx.fetch`; will need to update its mocks. Quick.
- We are NOT relaxing SSRF guards. Keep `validateAndResolveFetchUrl` as-is.
- If `pnpm dev:once` is racy with the running pid 35083, kill explicitly before rebuild.

## Open questions

None blocking. Test stub adjustment is the only thing that might surprise mid-flight.

## Don't do

- Do NOT add `127.0.0.1` to the SSRF allow-list. Plugins should not be able to scan localhost.
- Do NOT scope-creep into other holacracy triggers right now (B2 only is the gate to V).
- Do NOT run `pnpm dev` (watch mode) — kills in-flight agent runs.
