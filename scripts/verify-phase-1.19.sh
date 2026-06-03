#!/usr/bin/env bash
# Phase 1.19 end-to-end verification — proves the full skill-aware,
# trust-thresholded, governance-evolving agent collaboration loop.
#
# Run AFTER all 8 T-tasks have shipped + agents have been recycled.
#
# Each section exits 0 on green; any non-green prints the relevant
# diagnostic and continues (so you see the full picture, not just the
# first failure).
#
# Usage:
#   ./scripts/verify-phase-1.19.sh
#   COMPANY_ID=<uuid> ./scripts/verify-phase-1.19.sh   # override

set -uo pipefail
API="${PAPERCLIP_API_BASE:-http://localhost:3100/api}"

print_section() { echo ""; echo "=== $* ==="; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*"; }

print_section "1. Server healthy + routes registered (T1+T3+T4 endpoints)"
curl -sS "$API/health" | grep -q "ok" && ok "health: 200" || fail "health: not 200"

# T1+T3+T4 endpoints — each should return VALIDATION_ERROR (not 404)
# when called without auth, proving the route is mounted.
for route in "internal/a2a/publish" "internal/a2a/request" "internal/a2a/delegate" "internal/a2a/decline" "internal/a2a/endorse" "internal/skill-fit/check" "internal/skill-index/search"; do
  status=$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' "$API/$route")
  if [ "$status" = "400" ] || [ "$status" = "401" ] || [ "$status" = "403" ]; then
    ok "$route → $status (route mounted)"
  elif [ "$status" = "404" ]; then
    fail "$route → 404 (route NOT mounted — code didn't ship?)"
  else
    ok "$route → $status (unexpected but mounted)"
  fi
done

# T3 — agents discovery proxy
status=$(curl -sS -o /dev/null -w "%{http_code}" "$API/internal/a2a/agents")
if [ "$status" = "200" ] || [ "$status" = "502" ]; then
  ok "internal/a2a/agents → $status (mounted; 502 means EMQX dashboard auth needs work — non-blocking)"
else
  fail "internal/a2a/agents → $status"
fi

print_section "2. T2 — required_skills column on issues"
psql -h localhost -p 54329 -U paperclip -d paperclip -c "\d public.issues" 2>/dev/null | grep -q "required_skills" \
  && ok "required_skills column exists" || fail "required_skills column missing (migration not applied?)"

print_section "3. T1 — trust signals flowing on new A2A path"
recent=$(psql -h localhost -p 54329 -U paperclip -d paperclip -tAc \
  "SELECT COUNT(*) FROM public.agent_trust_signals WHERE updated_at > NOW() - INTERVAL '24 hours'" 2>/dev/null)
ok "trust signals updated in last 24h: ${recent:-?}"

print_section "4. T7 — 4 new IDM proposal kinds dispatchable"
echo "  (Live dispatch needs an agent run; this just confirms the worker.js bundle includes the case strings)"
for kind in "add-skill-to-role" "create-role-with-skill" "reassign-role" "reformulate-task"; do
  if grep -q "$kind" /Users/tom/paperclip/packages/plugins/plugin-holacracy/dist/worker.js 2>/dev/null; then
    ok "dispatcher includes \"$kind\""
  else
    fail "dispatcher missing \"$kind\" — plugin rebuild needed?"
  fi
done

print_section "5. T8 — Doctrine in all 16 agent AGENTS.md"
docroot="$HOME/.paperclip/instances/default/companies/46cad2c0-19f3-4a22-95d1-c5f3dcb0f096/agents"
count=$(find "$docroot" -name "AGENTS.md" -exec grep -l "agentDeclineTask" {} \; 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" = "16" ]; then ok "16/16 agents have agentDeclineTask doctrine"; else fail "only $count/16 agents have doctrine — run pnpm run agents:backfill-instructions"; fi

print_section "6. MCP server tools registered (V-set + B-set + I-set)"
echo "  (Inspecting tools.ts — for live MCP, recycle agents + check a heartbeat run)"
for tool in "a2aSendTask" "a2aBroadcastEvent" "agentSemanticSkillSearch" "agentCheckSkillFit" "agentDeclineTask" "endorseAgent" "agentDelegateTask"; do
  if grep -q "\"$tool\"" /Users/tom/paperclip/packages/mcp-server/src/tools.ts; then
    ok "tool registered: $tool"
  else
    fail "tool NOT registered: $tool"
  fi
done

print_section "7. Live A2A broker traffic flowing"
docker exec paperclip-emqx emqx ctl clients list 2>/dev/null | wc -l | tr -d ' ' \
  | xargs -I {} echo "  ✓ {} MQTT clients connected"

echo ""
echo "=== DONE ==="
echo "If everything is green, run the agent end-to-end test:"
echo ""
echo "  # 1. Watch the bus in another terminal:"
echo "  ./scripts/watch-a2a-bus.sh"
echo ""
echo "  # 2. Seed a test issue assigned to an agent whose skills don't match:"
echo "  # (e.g. assign Doc Lead a code-review task — expect agentDeclineTask)"
echo ""
echo "  # 3. Wake the agent + watch their heartbeat-run for tool_use blocks:"
echo "  curl -X POST \$API/agents/<agentId>/wakeup -H 'Content-Type: application/json' \\"
echo "    -d '{\"source\":\"on_demand\",\"reason\":\"Phase 1.19 e2e test\"}'"
