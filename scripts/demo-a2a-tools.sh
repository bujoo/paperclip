#!/usr/bin/env bash
# E8 — Quick smoke test of the A2A MCP tools' backing HTTP endpoints.
#
# These are the same endpoints the MCP server child process calls when
# an agent invokes mcp__paperclip-mcp__a2a*. If they work via curl, they
# work via the MCP tool.
#
# Usage: ./scripts/demo-a2a-tools.sh

set -euo pipefail

PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3100/api}"
COMPANY_ID="${COMPANY_ID:-}"

# Resolve company id from issue prefix if not provided.
if [ -z "${COMPANY_ID}" ]; then
  COMPANY_ID="$(curl -sS "${PAPERCLIP_API_BASE}/companies" | python3 -c 'import json,sys; d=json.load(sys.stdin); m=[c for c in (d if isinstance(d,list) else d.get("companies",[])) if c.get("issue_prefix")=="MYA" or c.get("issuePrefix")=="MYA"]; print(m[0]["id"] if m else "")')"
  if [ -z "${COMPANY_ID}" ]; then
    echo "Could not resolve MYA company id. Set COMPANY_ID env var explicitly." >&2
    exit 1
  fi
fi

echo "=== E8 A2A smoke test (company=${COMPANY_ID}) ==="

echo ""
echo "1. GET /api/internal/a2a/agents — list live agents from EMQX A2A Registry"
echo "   (fails gracefully if EMQX dashboard isn't reachable on :18083 — non-blocking)"
curl -sS "${PAPERCLIP_API_BASE}/internal/a2a/agents" | head -c 300
echo ""

echo ""
echo "2. POST /api/internal/a2a/publish — fire-and-forget (no auth = expects VALIDATION_ERROR for missing companyId, confirming the route is wired)"
curl -sS -X POST "${PAPERCLIP_API_BASE}/internal/a2a/publish" \
  -H "Content-Type: application/json" \
  -d '{}'
echo ""

echo ""
echo "3. POST /api/internal/a2a/publish — with agent auth (expects AGENT_AUTH_REQUIRED — confirms auth path runs)"
curl -sS -X POST "${PAPERCLIP_API_BASE}/internal/a2a/publish" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"${COMPANY_ID}\",\"kind\":\"event-self\",\"payload\":{\"kind\":\"demo\",\"body\":\"hello\"}}"
echo ""

echo ""
echo "=== To test end-to-end (with agent auth) ==="
echo ""
echo "Wake any agent on a task that asks them to use one of these MCP tools:"
echo ""
echo "  curl -X POST ${PAPERCLIP_API_BASE}/agents/<agent-id>/wakeup \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"source\":\"on_demand\",\"reason\":\"test a2aBroadcastEvent\"}'"
echo ""
echo "Then watch the agent's heartbeat run for a tool_use block naming"
echo "mcp__paperclip-mcp__a2aSendTask, a2aBroadcastEvent, etc."
echo ""
echo "Watch broker traffic in another terminal:"
echo "  mosquitto_sub -h localhost -p 1883 -u <username> -P <password> -t '\$a2a/v1/#' -v"
echo ""
echo "(See docs/specs/a2a-mqtt-protocol.md for credential details.)"
