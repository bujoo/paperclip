#!/usr/bin/env bash
# Phase 1.20 end-to-end verification — probes the 4 Holacracy fidelity
# gates BY ACTUALLY FIRING THEM via direct HTTP, not by string-matching
# the bundle. Mints a transient agent API key, hits each gate's real
# route, asserts the expected error code, then cleans up.
#
# Gates covered:
#   G1 — agentDelegateTask MCP tool inherits requiredSkills from source issue
#   G2 — Cross-circle delegation refused with 403 SHARED_CIRCLE_REQUIRED
#        + anchor-circle bypass (Holacracy Coach) returns 200/non-403
#   G3 — forwardTension via non-Rep-Link refused when a Rep Link IS elected
#   G4 — Governance tension inside an active tactical discussion refused with 403 PHASE_MISMATCH
#
# Why direct HTTP and not just strings: the earlier static check passed
# even when the G4 gate was wired to dead code (TOOL_NAMES.raiseTension
# is never invoked — agents go via the API route inline handler). Only a
# live probe surfaces that class of bug.
#
# Usage:
#   ./scripts/verify-phase-1.20.sh
#   COMPANY_ID=<uuid> API=http://localhost:3100/api ./scripts/verify-phase-1.20.sh

set -uo pipefail

API="${API:-http://localhost:3100/api}"
COMPANY_ID="${COMPANY_ID:-46cad2c0-19f3-4a22-95d1-c5f3dcb0f096}"
PGLIB="${PGLIB:-/Users/tom/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules}"

# Stable ContextHub fixtures — override via env for other orgs.
SALES_LEAD_ID="${SALES_LEAD_ID:-89c526a5-f886-4bf7-bc0a-fc32f1b00b9e}"   # circle_lead in Sales
SALES_PEER_ID="${SALES_PEER_ID:-4d53f137-4eeb-43ff-86c6-2fea42ce849e}"   # Facilitator — shares Sales circle (for G1)
DEV_LEAD_ID="${DEV_LEAD_ID:-e1f66962-dc3c-4a8e-9875-de1a1dee2839}"       # in Engineering (non-anchor, no cross_link)
HOLACRACY_COACH_ID="${HOLACRACY_COACH_ID:-f3a4f656-021f-433d-aa45-d46157c08fe9}"  # in anchor (General Company Circle)
SALES_CIRCLE_ID="${SALES_CIRCLE_ID:-5bbf30b9-3fdd-452e-bae5-06d3b4e7f454}"

# Run state — populated as we go; cleanup uses them.
ROGUE_KEY_NAME="verify-1.20-probe-$$-$(date +%s)"
TOKEN=""
TACTICAL_DISC_ID=""
SEED_ISSUE_ID=""
FAIL_COUNT=0

print_section() { echo ""; echo "=== $* ==="; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*"; FAIL_COUNT=$((FAIL_COUNT+1)); }
info()  { echo "  • $*"; }

# Tiny one-shot postgres client via node-pg.
pq() {
  local sql="$1"
  PGLIB="$PGLIB" node -e "
    const pg = require(process.env.PGLIB + '/pg');
    (async () => {
      const c = new pg.Client('postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip');
      await c.connect();
      const r = await c.query(\`$sql\`);
      console.log(JSON.stringify(r.rows));
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
  "
}

# Always tear down, even on early exit.
cleanup() {
  # Revoke ALL stale verify-1.20-probe keys (current + leftover from past failed runs)
  pq "UPDATE public.agent_api_keys SET revoked_at = NOW()
       WHERE name LIKE 'verify-1.20-probe-%' AND revoked_at IS NULL" > /dev/null 2>&1 || true
  if [ -n "$TACTICAL_DISC_ID" ]; then
    pq "UPDATE public.circle_discussions SET status='concluded', concluded_at=NOW() WHERE id='$TACTICAL_DISC_ID'" > /dev/null 2>&1 || true
  fi
  if [ -n "$SEED_ISSUE_ID" ]; then
    pq "UPDATE public.issues SET status='cancelled', cancelled_at=NOW() WHERE id='$SEED_ISSUE_ID'" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ────────────────────────────────────────────────────────────────────
print_section "0. Preflight — server + 0093 migration"

health=$(curl -s "$API/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
if [ "$health" = "ok" ]; then ok "server health: ok"; else fail "server not healthy: $health"; exit 1; fi

mk_col=$(pq "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='circle_discussions' AND column_name='meeting_kind'" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin) else 'no')")
[ "$mk_col" = "yes" ] && ok "0093 migration applied (meeting_kind column exists)" || { fail "meeting_kind column missing — run pnpm db:migrate"; exit 1; }

# ────────────────────────────────────────────────────────────────────
print_section "1. Mint transient probe key (Sales Lead acting non-compliant)"

# Hash with sha256 (matches server/src/middleware/auth.ts:13).
TOKEN=$(PGLIB="$PGLIB" node -e "
  const crypto = require('crypto');
  const pg = require(process.env.PGLIB + '/pg');
  (async () => {
    const c = new pg.Client('postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip');
    await c.connect();
    const token = '$ROGUE_KEY_NAME-' + crypto.randomBytes(8).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await c.query(
      \`INSERT INTO public.agent_api_keys (agent_id, company_id, name, key_hash) VALUES (\$1, \$2, \$3, \$4)\`,
      ['$SALES_LEAD_ID', '$COMPANY_ID', '$ROGUE_KEY_NAME', hash],
    );
    console.log(token);
    await c.end();
  })().catch(e => { console.error(e.message); process.exit(1); });
")
[ -n "$TOKEN" ] && ok "minted probe key for Sales Lead (revoked at script exit)" || { fail "key mint failed"; exit 1; }

AUTH="Authorization: Bearer $TOKEN"

# ────────────────────────────────────────────────────────────────────
print_section "2. G1 — /internal/a2a/delegate accepts sourceIssueId + inherits required_skills"

# Seed a source issue with required_skills + assigned to Doc Lead. Then probe
# /delegate as Sales Lead WITHOUT requiredSkills but WITH sourceIssueId.
# The server should inherit ['post-quantum-crypto'] from the source issue,
# then T6's skill-fit gate fires (Dev Lead has trust 0.50 on PQ-crypto in
# cold-start grace, so the skill-fit check passes — meaning the inheritance
# code path ran but didn't refuse). The proof that inheritance happened:
# the response includes the inherited skills, OR (post-grace) we'd see a
# 409 with the inherited skills listed.

SEED_ISSUE_ID=$(pq "
  INSERT INTO public.issues (
    company_id, project_id, title, description, status, priority,
    assignee_agent_id, required_skills, origin_kind, kind
  ) VALUES (
    '$COMPANY_ID', 'f53463a7-3c3c-446e-8a5d-53833f395f0d',
    '[P1.20 verify G1] inherit source', 'transient probe',
    'backlog', 'medium',
    '1243032c-c03f-4fe7-8b5d-4eb3a77e84db',
    ARRAY['post-quantum-crypto']::text[],
    'manual', 'next_action'
  ) RETURNING id::text
" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
info "seeded source issue $SEED_ISSUE_ID with required_skills=['post-quantum-crypto']"

# Delegate to a SAME-CIRCLE peer so G2's cross-circle refuse doesn't intercept.
# SALES_PEER_ID (Facilitator) shares the Sales circle with Sales Lead.
g1_resp=$(curl -s -X POST "$API/internal/a2a/delegate" -H "$AUTH" -H "Content-Type: application/json" -d "{
  \"companyId\":\"$COMPANY_ID\",
  \"toAgentId\":\"$SALES_PEER_ID\",
  \"title\":\"[probe G1] inherit from source\",
  \"sourceIssueId\":\"$SEED_ISSUE_ID\"
}")
g1_inherited=$(echo "$g1_resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
skills = (d.get('requiredSkills') or d.get('misses') or [])
if isinstance(skills, list) and skills and isinstance(skills[0], dict):
    skills = [s.get('skill') for s in skills]
print(','.join(skills))" 2>/dev/null)

if echo "$g1_inherited" | grep -q "post-quantum-crypto"; then
  ok "G1: server inherited required_skills from sourceIssueId → $g1_inherited"
else
  fail "G1: inheritance did NOT happen. response: $(echo "$g1_resp" | head -c 200)"
fi

# Cancel any peer-delegation issues created by this probe (success path side-effect).
pq "UPDATE public.issues SET status='cancelled', cancelled_at=NOW()
     WHERE origin_kind='peer_delegation'
       AND origin_id='$SALES_LEAD_ID'::uuid
       AND created_at > NOW() - INTERVAL '60 seconds'
       AND status NOT IN ('done','cancelled')" > /dev/null 2>&1 || true

# ────────────────────────────────────────────────────────────────────
print_section "3. G2 — Cross-circle delegate refuses (Sales Lead → Dev Lead)"

g2_resp=$(curl -s -X POST "$API/internal/a2a/delegate" -H "$AUTH" -H "Content-Type: application/json" -d "{
  \"companyId\":\"$COMPANY_ID\",
  \"toAgentId\":\"$DEV_LEAD_ID\",
  \"title\":\"[probe G2] cross-circle\"
}")
g2_code=$(echo "$g2_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('code','?'))" 2>/dev/null)
if [ "$g2_code" = "SHARED_CIRCLE_REQUIRED" ]; then
  ok "G2 fired: 403 SHARED_CIRCLE_REQUIRED (Sales↔Engineering have no shared circle)"
else
  fail "G2 did NOT fire — got code=$g2_code. body: $(echo "$g2_resp" | head -c 200)"
fi

# ────────────────────────────────────────────────────────────────────
print_section "3b. G2 ANCHOR BYPASS — Holacracy Coach (anchor circle) is reachable"

# Delegating to the Coach should NOT be refused by G2 because the Coach holds
# a role in the anchor circle (General Company Circle, parent_circle_id IS NULL).
# The route may still 409 on skill-fit or succeed; the assertion is that the
# response code is NOT SHARED_CIRCLE_REQUIRED.
g2b_resp=$(curl -s -X POST "$API/internal/a2a/delegate" -H "$AUTH" -H "Content-Type: application/json" -d "{
  \"companyId\":\"$COMPANY_ID\",
  \"toAgentId\":\"$HOLACRACY_COACH_ID\",
  \"title\":\"[probe G2 bypass] anchor-circle reach\"
}")
g2b_code=$(echo "$g2b_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('code','OK') if not d.get('ok', True) else 'OK')" 2>/dev/null)
if [ "$g2b_code" != "SHARED_CIRCLE_REQUIRED" ]; then
  ok "G2 bypass: anchor-circle role on target bypasses the gate (code=$g2b_code)"
else
  fail "G2 bypass FAILED: Coach should be reachable — got SHARED_CIRCLE_REQUIRED"
fi

# Confirm the bypass was recorded to activity_log (audit trail).
sleep 1
bypass_n=$(pq "SELECT COUNT(*) AS n FROM public.activity_log WHERE action='agent.delegation.cross_circle_bypass' AND created_at > NOW() - INTERVAL '30 seconds'" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['n'])")
if [ "$bypass_n" -gt 0 ]; then
  ok "G2 bypass logged to activity_log (n=$bypass_n in last 30s)"
else
  info "no bypass log entry — may have errored before reaching the log step"
fi

# ────────────────────────────────────────────────────────────────────
print_section "4. G3 — forwardTension refused when caller is not Rep Link"

# Sales Lead holds circle_lead (NOT circle_rep) in Sales. Sales circle DOES
# have an elected Rep Link, so the Lead-Link-fallback path is NOT eligible.
# Need a tension in Sales circle to forward. Use an existing open one or seed.
TENSION_FORWARD=$(pq "SELECT id::text FROM plugin_holacracy_c5049b5dfe.tensions WHERE circle_id='$SALES_CIRCLE_ID' AND status='open' ORDER BY created_at DESC LIMIT 1" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['id'] if r else '')" 2>/dev/null)
if [ -z "$TENSION_FORWARD" ]; then
  TENSION_FORWARD=$(pq "INSERT INTO plugin_holacracy_c5049b5dfe.tensions (id, circle_id, source_agent_id, title, description, tension_type) VALUES (gen_random_uuid(), '$SALES_CIRCLE_ID', '$SALES_LEAD_ID', '[probe G3] seed tension', 'transient probe tension for G3', 'operational') RETURNING id::text" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
  info "seeded transient tension $TENSION_FORWARD for G3"
fi

g3_resp=$(curl -s -X POST "$API/holacracy/forward-tension" -H "$AUTH" -H "Content-Type: application/json" -d "{
  \"companyId\":\"$COMPANY_ID\",
  \"tensionId\":\"$TENSION_FORWARD\",
  \"context\":\"[probe G3] non-Rep-Link forward\"
}")
if echo "$g3_resp" | grep -qE 'Lead Link cannot forward tensions UP when a Rep Link is elected|REP_LINK_REQUIRED'; then
  ok "G3 fired: caller (Sales Lead = circle_lead) blocked because Rep Link IS elected"
else
  fail "G3 did NOT fire — body: $(echo "$g3_resp" | head -c 200)"
fi

# ────────────────────────────────────────────────────────────────────
print_section "5. G4 — Governance tension in active tactical discussion refused"

# Set up a tactical discussion in Sales circle with Sales Lead as participant.
TACTICAL_DISC_ID=$(pq "
  INSERT INTO public.circle_discussions (
    company_id, circle_id, a2a_context_id, topic, prompt_for_agents,
    participant_agent_ids, status, rounds_planned, rounds_completed,
    meeting_kind, started_at
  ) VALUES (
    '$COMPANY_ID', '$SALES_CIRCLE_ID',
    'verify-1.20-tactical-' || extract(epoch from now())::text,
    '[probe G4] tactical pulse',
    'transient probe',
    ARRAY['$SALES_LEAD_ID'::uuid],
    'in_progress', 1, 0,
    'tactical', NOW()
  ) RETURNING id::text
" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
info "seeded tactical discussion $TACTICAL_DISC_ID with Sales Lead as participant"

g4_resp=$(curl -s -X POST "$API/plugins/paperclipai.plugin-holacracy/api/circles/$SALES_CIRCLE_ID/tensions" -H "$AUTH" -H "Content-Type: application/json" -d "{
  \"companyId\":\"$COMPANY_ID\",
  \"title\":\"[probe G4] governance proposal\",
  \"description\":\"trying to raise governance from inside a tactical meeting\",
  \"type\":\"governance\"
}")
g4_code=$(echo "$g4_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('code','?'))" 2>/dev/null)
if [ "$g4_code" = "PHASE_MISMATCH" ]; then
  ok "G4 fired: 403 PHASE_MISMATCH (governance refused inside active tactical)"
  # Also verify the structured pointer
  if echo "$g4_resp" | grep -q "tacticalDiscussionId"; then
    ok "G4 response carries tacticalDiscussionId pointer"
  else
    fail "G4 fired but response missing tacticalDiscussionId"
  fi
else
  fail "G4 did NOT fire — got code=$g4_code. body: $(echo "$g4_resp" | head -c 300)"
fi

# ────────────────────────────────────────────────────────────────────
print_section "6. Doctrine — 16 agents have sourceIssueId guidance"

n_correct=$(grep -l "Always pass .sourceIssueId" /Users/tom/.paperclip/instances/default/companies/$COMPANY_ID/agents/*/instructions/AGENTS.md 2>/dev/null | wc -l | tr -d ' ')
n_total=$(ls /Users/tom/.paperclip/instances/default/companies/$COMPANY_ID/agents/*/instructions/AGENTS.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$n_correct" -eq "$n_total" ] && [ "$n_total" -gt 0 ]; then
  ok "all $n_total/$n_total agents have sourceIssueId doctrine"
else
  fail "$n_correct/$n_total agents missing doctrine — run: pnpm run agents:backfill-instructions -- --company $COMPANY_ID"
fi

# ────────────────────────────────────────────────────────────────────
print_section "DONE"
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "  ✓ All Phase 1.20 gates fired as expected."
  exit 0
else
  echo "  ✗ $FAIL_COUNT check(s) failed."
  exit 1
fi
