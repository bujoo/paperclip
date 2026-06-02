#!/usr/bin/env python3
"""
Accountability Scanner — runs daily at 03:00 local
For each agent, evaluates due accountabilities and raises governance tensions on breach.
Idempotency key: (agent_id, accountability_name, scan_date) — no duplicate tensions per day.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone, date
from urllib.request import urlopen, Request
from urllib.error import URLError

# Config
API_BASE = f"http://localhost:{os.environ.get('PAPERCLIP_LISTEN_PORT', '3102')}/api"
COMPANY_ID = "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096"
GCC_CIRCLE_ID = "86948526-54dc-4662-b952-e3225ff5727a"
HOLACRACY_API = f"{API_BASE}/plugins/paperclipai.plugin-holacracy/api"

# Agent-to-primary-circle mapping (circle where agent is circle_lead or has custom role)
AGENT_CIRCLE_MAP = {
    "2b9fda1c-5163-4ab9-9a52-e955e95c93ac": "86948526-54dc-4662-b952-e3225ff5727a",  # Hermes -> GCC
    "1243032c-c03f-4fe7-8b5d-4eb3a77e84db": "05dc8b9e-fee7-4358-9f07-e7ca77d17f73",  # Doc Lead -> Documentation
    "e1f66962-dc3c-4a8e-9875-de1a1dee2839": "7f0b67da-a4c5-4787-954b-a75dd035a2da",  # Dev Lead -> Engineering
    "c8cd3e0c-de83-4bc6-b568-66651c5e925e": "c3c44ca0-0699-4a47-b963-64342f8da87b",  # Growth Lead -> Marketing
    "9adc6c20-de6e-4f0a-83de-ebe8a380f5d0": "0b478cf8-1886-48fe-ab3e-f282a256d0bc",  # PM -> Product
    "2172891c-cec4-4886-8a05-afe483fd7061": "716a1e05-12eb-4662-86ca-139afeb23822",  # PM Coord -> ProjectMgmt
    "b7e25a62-179b-44eb-962e-3a23eb06c0ea": "40c00838-9e08-411d-8d87-49d0117b4532",  # QA Lead -> ReleaseQA
    "89c526a5-f886-4bf7-bc0a-fc32f1b00b9e": "06f1bee0-441d-42d7-8c89-f2ecc78bf001",  # Sales Lead -> Sales
    "aec05dae-7af7-4323-a21e-00040fbc766a": "bd3af533-3cd5-4683-b8d4-ce484f4b0cde",  # Strategist -> Strategy
    # Placeholder roles -> GCC
    "4d53f137-4eeb-43ff-86c6-2fea42ce849e": "86948526-54dc-4662-b952-e3225ff5727a",  # Facilitator
    "62c7a2b3-5358-4ce2-99fc-b78cfff974b5": "86948526-54dc-4662-b952-e3225ff5727a",  # Secretary
    "322d0092-a348-4dae-a195-a0dd7e96ecd5": "86948526-54dc-4662-b952-e3225ff5727a",  # Circle Rep
    "54b0194c-dd57-4c43-a7c7-9e3071d2e7d3": "86948526-54dc-4662-b952-e3225ff5727a",  # Researcher -> GCC (no dedicated circle)
}


def api_get(path):
    """HTTP GET, returns parsed JSON."""
    url = f"{API_BASE}{path}"
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except URLError as e:
        print(f"  GET {path} failed: {e}", file=sys.stderr)
        return None


def holacracy_get(path):
    """GET against the holacracy plugin API."""
    url = f"{HOLACRACY_API}{path}"
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except URLError as e:
        print(f"  GET holacracy{path} failed: {e}", file=sys.stderr)
        return None


def holacracy_post(path, body):
    """POST against the holacracy plugin API."""
    url = f"{HOLACRACY_API}{path}"
    data = json.dumps(body).encode()
    req = Request(url, data=data, method="POST",
                  headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except URLError as e:
        print(f"  POST holacracy{path} failed: {e}", file=sys.stderr)
        return None


def get_all_agents():
    data = api_get(f"/companies/{COMPANY_ID}/agents")
    return data if isinstance(data, list) else []


def get_issues(assignee_id=None, status=None):
    """Fetch issues for company, optionally filtered."""
    params = []
    if assignee_id:
        params.append(f"assigneeAgentId={assignee_id}")
    if status:
        params.append(f"status={status}")
    qs = "&".join(params)
    path = f"/companies/{COMPANY_ID}/issues" + (f"?{qs}" if qs else "")
    data = api_get(path)
    return data if isinstance(data, list) else []


def parse_issue_date(s):
    """Parse ISO8601 date string."""
    if not s:
        return None
    try:
        # Handle +04 offset and fractional seconds
        s = re.sub(r'\+\d{2}$', '+00:00', s)
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None


# --------------------------------------------------------------------------
# Metric evaluators
# Each function returns (value, breached: bool)
# --------------------------------------------------------------------------

def eval_count_done_last7d(agent_id, threshold):
    """Count issues closed by agent in last 7 days."""
    now = datetime.now(timezone.utc)
    issues = get_issues(assignee_id=agent_id, status="done")
    count = 0
    for iss in issues:
        completed = parse_issue_date(iss.get("completedAt") or iss.get("updatedAt"))
        if completed and (now - completed).days <= 7:
            count += 1
    # Caller responsible for direction-aware breach logic via alert_direction field
    return count, False  # return raw count; caller decides breach based on direction


def eval_avg_inprogress_hours(agent_id, threshold):
    """Average hours issues have been in_progress without update (stale)."""
    now = datetime.now(timezone.utc)
    issues = get_issues(assignee_id=agent_id, status="in_progress")
    if not issues:
        return 0, False
    stale_hours = []
    for iss in issues:
        updated = parse_issue_date(iss.get("updatedAt"))
        if updated:
            hours = (now - updated).total_seconds() / 3600
            stale_hours.append(hours)
    if not stale_hours:
        return 0, False
    avg = sum(stale_hours) / len(stale_hours)
    breached = avg > float(threshold)
    return round(avg, 1), breached


def eval_unrouted_backlog(agent_id, threshold):
    """Count unassigned backlog issues."""
    all_backlog = get_issues(status="backlog")
    unrouted = [i for i in all_backlog if not i.get("assigneeAgentId") and not i.get("assigneeUserId")]
    count = len(unrouted)
    breached = count > int(threshold)
    return count, breached


def eval_boolean_agent_active(agent_id, threshold):
    """Check if agent has any issue activity this month."""
    now = datetime.now(timezone.utc)
    issues = get_issues(assignee_id=agent_id)
    for iss in issues:
        updated = parse_issue_date(iss.get("updatedAt"))
        if updated and updated.month == now.month and updated.year == now.year:
            return True, False  # active, not breached
    return False, True  # inactive, breached


def evaluate_accountability(agent_id, acc):
    """
    Route accountability to the right evaluator based on metric name + cadence.
    Returns (value, breached).
    """
    name = acc.get("name", "")
    metric = acc.get("metric", "")
    threshold = acc.get("alert_threshold")
    alert_direction = acc.get("alert_direction", "lower_is_better")  # new field

    # agent_active placeholder: check any issue this month
    if name == "agent_active":
        value, breached = eval_boolean_agent_active(agent_id, threshold)
        return value, breached

    # Dev Lead: pr_review_latency_hours — proxy: avg stale in_progress hours
    if name == "pr_review_latency_hours":
        value, breached = eval_avg_inprogress_hours(agent_id, threshold)
        # latency: lower_is_better, so breach is already value > threshold (correct)
        return value, breached

    # Any latency/hours metric — avg stale in_progress as proxy
    if any(k in name for k in ("latency_hours", "turnaround_hours", "response_latency")):
        value, breached = eval_avg_inprogress_hours(agent_id, threshold)
        # latency: lower_is_better
        return value, breached

    # engineering_issues_completed_weekly
    if name == "engineering_issues_completed_weekly":
        value, breached = eval_count_done_last7d(agent_id, threshold)
        # completed: higher_is_better, so flip breach if direction says so
        if alert_direction == "higher_is_better":
            breached = value < int(threshold)
        return value, breached

    # PM Coordinator: unrouted_backlog_count
    if name == "unrouted_backlog_count":
        value, breached = eval_unrouted_backlog(agent_id, threshold)
        # unrouted count: lower_is_better, so breach is already value > threshold (correct)
        return value, breached

    # Count-based metrics (assume higher_is_better for most counts)
    if any(k in name for k in ("completed", "published", "deployed", "groomed", "per_assigned", "resolved")):
        value, breached = eval_count_done_last7d(agent_id, threshold if threshold is not None else 0)
        # these are typically higher_is_better
        if alert_direction == "higher_is_better":
            breached = value < int(threshold if threshold is not None else 0)
        return value, breached

    # Numeric threshold but unknown metric — use done count as proxy
    if isinstance(threshold, (int, float)) and threshold > 0:
        value, breached = eval_count_done_last7d(agent_id, threshold)
        if alert_direction == "higher_is_better":
            breached = value < int(threshold)
        return value, breached

    # Default: not measurable with available data — skip (return None, False)
    return None, False


def cadence_is_due(cadence, today):
    """Determine if this cadence should run today."""
    if cadence == "daily":
        return True
    if cadence == "weekly":
        return today.weekday() == 0  # Monday
    if cadence == "monthly":
        return today.day == 1
    if cadence == "hourly":
        return True  # run anyway; scanner runs daily
    return False


def get_existing_tensions_today(circle_id, scan_date_str):
    """Fetch tensions and filter those raised today (by title prefix)."""
    data = holacracy_get(f"/circles/{circle_id}/tensions?companyId={COMPANY_ID}&type=all")
    if not data or not isinstance(data, list):
        return set()
    # Build idempotency keys from existing tension titles
    keys = set()
    for t in data:
        title = t.get("title", "")
        # Title format: "[SCAN:{agent_id}:{acc_name}:{date}]"
        m = re.search(r'\[SCAN:([^:]+):([^:]+):(\d{4}-\d{2}-\d{2})\]', title)
        if m:
            keys.add(f"{m.group(1)}:{m.group(2)}:{m.group(3)}")
    return keys


def main():
    today = date.today()
    scan_date_str = today.isoformat()
    print(f"Accountability scan — {scan_date_str}")

    agents = get_all_agents()
    if not agents:
        print("No agents found. Abort.", file=sys.stderr)
        sys.exit(1)

    # Pre-fetch tension dedup keys per circle
    circle_keys_cache = {}

    tensions_raised = 0
    tensions_skipped_dedup = 0

    for agent in agents:
        agent_id = agent["id"]
        agent_name = agent.get("name", agent_id)
        accountabilities = agent.get("accountabilities") or []

        if not accountabilities:
            continue

        circle_id = AGENT_CIRCLE_MAP.get(agent_id, GCC_CIRCLE_ID)

        # Lazy-load dedup keys for this circle
        if circle_id not in circle_keys_cache:
            circle_keys_cache[circle_id] = get_existing_tensions_today(circle_id, scan_date_str)
        dedup_keys = circle_keys_cache[circle_id]

        for acc in accountabilities:
            cadence = acc.get("cadence", "daily")
            if not cadence_is_due(cadence, today):
                continue

            acc_name = acc.get("name", "unknown")
            idem_key = f"{agent_id}:{acc_name}:{scan_date_str}"

            if idem_key in dedup_keys:
                print(f"  SKIP (dedup) {agent_name} / {acc_name}")
                tensions_skipped_dedup += 1
                continue

            value, breached = evaluate_accountability(agent_id, acc)

            if not breached:
                print(f"  OK   {agent_name} / {acc_name} = {value}")
                continue

            # Build tension
            threshold = acc.get("alert_threshold")
            title = f"[SCAN:{agent_id}:{acc_name}:{scan_date_str}] {agent_name} breached {acc_name}: {value} vs threshold {threshold}"
            description = json.dumps({
                "agent_id": agent_id,
                "agent_name": agent_name,
                "accountability_name": acc_name,
                "metric_value": value,
                "threshold": threshold,
                "cadence": cadence,
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "escalation_path": acc.get("escalation_path", []),
            }, indent=2)

            print(f"  BREACH {agent_name} / {acc_name} = {value} (threshold {threshold}) → raising tension in circle {circle_id}")

            result = holacracy_post(f"/circles/{circle_id}/tensions", {
                "title": title,
                "description": description,
                "type": "operational",
                "companyId": COMPANY_ID,
            })

            tid = result.get("id") or result.get("tensionId") if result else None
            if tid:
                tensions_raised += 1
                dedup_keys.add(idem_key)
                print(f"    -> tension {tid}")
            else:
                print(f"    -> FAILED to raise tension: {result}", file=sys.stderr)

    print(f"\nDone. Raised: {tensions_raised}, Skipped (dedup): {tensions_skipped_dedup}")


if __name__ == "__main__":
    main()
