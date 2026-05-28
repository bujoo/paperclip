#!/usr/bin/env python3
"""Backfill starter accountabilities for all 14 agents via Paperclip API."""
import json
import urllib.request
import urllib.error

API_BASE = "http://127.0.0.1:3101/api"
COMPANY_ID = "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096"
API_KEY = "local-trusted-key"

# Agent ID -> accountabilities mapping
AGENT_ACCOUNTABILITIES = {
    # Strategist
    "aec05dae-7af7-4323-a21e-00040fbc766a": [
        {
            "name": "quarterly_strategy_doc_published",
            "metric": "count_documents_type_strategy_last_30d",
            "target": 1,
            "alert_threshold": 0,
            "cadence": "monthly",
            "escalation_path": []
        },
        {
            "name": "strategic_tensions_resolved_rate",
            "metric": "resolved_governance_tensions_pct_last_90d",
            "target": 0.8,
            "alert_threshold": 0.5,
            "cadence": "monthly",
            "escalation_path": []
        }
    ],
    # Product Manager
    "9adc6c20-de6e-4f0a-83de-ebe8a380f5d0": [
        {
            "name": "backlog_groomed_weekly",
            "metric": "issues_triaged_last_7d",
            "target": 5,
            "alert_threshold": 0,
            "cadence": "weekly",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        },
        {
            "name": "sprint_delivery_rate",
            "metric": "issues_done_vs_planned_pct_last_14d",
            "target": 0.8,
            "alert_threshold": 0.5,
            "cadence": "weekly",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Dev Lead
    "e1f66962-dc3c-4a8e-9875-de1a1dee2839": [
        {
            "name": "pr_review_latency_hours",
            "metric": "avg_hours_issue_in_review_status_last_7d",
            "target": 24,
            "alert_threshold": 48,
            "cadence": "daily",
            "escalation_path": ["9adc6c20-de6e-4f0a-83de-ebe8a380f5d0"]
        },
        {
            "name": "build_failure_rate",
            "metric": "failed_builds_pct_last_7d",
            "target": 0.05,
            "alert_threshold": 0.2,
            "cadence": "daily",
            "escalation_path": ["9adc6c20-de6e-4f0a-83de-ebe8a380f5d0"]
        }
    ],
    # Hermes (CoS)
    "2b9fda1c-5163-4ab9-9a52-e955e95c93ac": [
        {
            "name": "comms_response_latency_hours",
            "metric": "avg_hours_to_first_comment_on_assigned_issues_last_7d",
            "target": 4,
            "alert_threshold": 24,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        },
        {
            "name": "escalations_routed_rate",
            "metric": "escalations_resolved_pct_last_7d",
            "target": 1.0,
            "alert_threshold": 0.8,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # QA Lead
    "b7e25a62-179b-44eb-962e-3a23eb06c0ea": [
        {
            "name": "regression_pass_rate",
            "metric": "test_suite_pass_pct_last_7d",
            "target": 0.95,
            "alert_threshold": 0.85,
            "cadence": "weekly",
            "escalation_path": ["e1f66962-dc3c-4a8e-9875-de1a1dee2839"]
        },
        {
            "name": "bug_triage_latency_hours",
            "metric": "avg_hours_bug_unassigned_last_7d",
            "target": 8,
            "alert_threshold": 24,
            "cadence": "daily",
            "escalation_path": ["e1f66962-dc3c-4a8e-9875-de1a1dee2839"]
        }
    ],
    # Researcher
    "54b0194c-dd57-4c43-a7c7-9e3071d2e7d3": [
        {
            "name": "research_doc_per_assigned_issue",
            "metric": "research_docs_per_closed_issue_last_30d",
            "target": 1,
            "alert_threshold": 0,
            "cadence": "daily",
            "escalation_path": ["9adc6c20-de6e-4f0a-83de-ebe8a380f5d0"]
        },
        {
            "name": "research_issue_completion_rate",
            "metric": "issues_done_pct_assigned_last_30d",
            "target": 0.9,
            "alert_threshold": 0.6,
            "cadence": "weekly",
            "escalation_path": ["9adc6c20-de6e-4f0a-83de-ebe8a380f5d0"]
        }
    ],
    # PM Coordinator
    "2172891c-cec4-4886-8a05-afe483fd7061": [
        {
            "name": "unrouted_backlog_count",
            "metric": "count_backlog_issues_unassigned",
            "target": 5,
            "alert_threshold": 10,
            "cadence": "daily",
            "escalation_path": ["9adc6c20-de6e-4f0a-83de-ebe8a380f5d0"]
        },
        {
            "name": "routing_accuracy_rate",
            "metric": "correctly_routed_issues_pct_last_7d",
            "target": 0.95,
            "alert_threshold": 0.8,
            "cadence": "weekly",
            "escalation_path": ["9adc6c20-de6e-4f0a-83de-ebe8a380f5d0"]
        }
    ],
    # Workflow Architect
    "d3715d54-6c06-4535-abe4-e51523968f38": [
        {
            "name": "governance_proposal_turnaround_hours",
            "metric": "avg_hours_governance_tension_open_last_30d",
            "target": 24,
            "alert_threshold": 72,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        },
        {
            "name": "process_documentation_currency",
            "metric": "days_since_last_workflow_doc_update",
            "target": 14,
            "alert_threshold": 30,
            "cadence": "weekly",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Zombie/inactive agents — placeholder accountability for action 9 detection
    # Sales Lead
    "89c526a5-f886-4bf7-bc0a-fc32f1b00b9e": [
        {
            "name": "agent_active",
            "metric": "last_heartbeat_within_30d",
            "target": True,
            "alert_threshold": False,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Growth Lead
    "c8cd3e0c-de83-4bc6-b568-66651c5e925e": [
        {
            "name": "agent_active",
            "metric": "last_heartbeat_within_30d",
            "target": True,
            "alert_threshold": False,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Doc Lead
    "1243032c-c03f-4fe7-8b5d-4eb3a77e84db": [
        {
            "name": "agent_active",
            "metric": "last_heartbeat_within_30d",
            "target": True,
            "alert_threshold": False,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Facilitator
    "4d53f137-4eeb-43ff-86c6-2fea42ce849e": [
        {
            "name": "agent_active",
            "metric": "last_heartbeat_within_30d",
            "target": True,
            "alert_threshold": False,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Secretary
    "62c7a2b3-5358-4ce2-99fc-b78cfff974b5": [
        {
            "name": "agent_active",
            "metric": "last_heartbeat_within_30d",
            "target": True,
            "alert_threshold": False,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
    # Circle Rep
    "322d0092-a348-4dae-a195-a0dd7e96ecd5": [
        {
            "name": "agent_active",
            "metric": "last_heartbeat_within_30d",
            "target": True,
            "alert_threshold": False,
            "cadence": "daily",
            "escalation_path": ["aec05dae-7af7-4323-a21e-00040fbc766a"]
        }
    ],
}


def patch_agent(agent_id, accountabilities):
    url = f"{API_BASE}/agents/{agent_id}"
    data = json.dumps({"accountabilities": accountabilities}).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="PATCH",
        headers={
            "Content-Type": "application/json",
            "X-Paperclip-API-Key": API_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
            return True, body.get("name", agent_id)
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode()[:200]}"
    except Exception as ex:
        return False, str(ex)


def main():
    ok_count = 0
    fail_count = 0
    for agent_id, accs in AGENT_ACCOUNTABILITIES.items():
        success, info = patch_agent(agent_id, accs)
        status = "OK" if success else "FAIL"
        print(f"[{status}] {agent_id} ({info}) — {len(accs)} accountability(s)")
        if success:
            ok_count += 1
        else:
            fail_count += 1

    print(f"\nDone: {ok_count} ok, {fail_count} failed")


if __name__ == "__main__":
    main()
