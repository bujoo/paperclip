#!/usr/bin/env tsx
/**
 * MYA-77: Backfill structured accountabilities for all 14 agents.
 * Run: npx tsx scripts/backfill-accountabilities.ts
 */

const API_BASE = "http://localhost:3100/api";
const API_KEY = "local-trusted-key";

interface Accountability {
  name: string;
  metric: string;
  target: number | string | boolean;
  alert_threshold: number | string | boolean;
  alert_direction?: "higher_is_better" | "lower_is_better";
  cadence: "hourly" | "daily" | "weekly" | "monthly";
  escalation_path?: string[];
}

// Agent IDs from the company
const AGENTS: Record<string, { id: string; accountabilities: Accountability[] }> = {
  Strategist: {
    id: "aec05dae-7af7-4323-a21e-00040fbc766a",
    accountabilities: [
      {
        name: "quarterly_strategy_doc_published",
        metric: "count of strategy documents published this month",
        target: 1,
        alert_threshold: 0,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
      {
        name: "company_heuristics_current",
        metric: "days since last strategy heuristic update",
        target: 30,
        alert_threshold: 60,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "weekly",
      },
    ],
  },
  "Product Manager": {
    id: "9adc6c20-de6e-4f0a-83de-ebe8a380f5d0",
    accountabilities: [
      {
        name: "backlog_groomed_weekly",
        metric: "count of backlog issues triaged and prioritized this week",
        target: 5,
        alert_threshold: 0,         alert_direction: "higher_is_better",
        alert_direction: "lower_is_better",
        cadence: "weekly",
      },
      {
        name: "roadmap_current",
        metric: "days since last roadmap update",
        target: 7,
        alert_threshold: 14,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "weekly",
      },
    ],
  },
  "Dev Lead": {
    id: "e1f66962-dc3c-4a8e-9875-de1a1dee2839",
    accountabilities: [
      {
        name: "pr_review_latency_hours",
        metric: "average hours from PR opened to first review",
        target: 24,
        alert_threshold: 48,         alert_direction: "higher_is_better",
        alert_direction: "lower_is_better",
        cadence: "daily",
      },
      {
        name: "engineering_issues_completed_weekly",
        metric: "count of engineering issues marked done this week",
        target: 3,
        alert_threshold: 5,
        alert_direction: "higher_is_better",
        cadence: "weekly",
      },
    ],
  },
  "QA Lead": {
    id: "b7e25a62-179b-44eb-962e-3a23eb06c0ea",
    accountabilities: [
      {
        name: "regression_pass_rate",
        metric: "ratio of passing regression tests to total regression tests",
        target: 0.95,
        alert_threshold: 0.85,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "weekly",
      },
      {
        name: "qa_sign_off_latency_hours",
        metric: "average hours from build ready to QA sign-off",
        target: 24,
        alert_threshold: 72,         alert_direction: "higher_is_better",
        alert_direction: "lower_is_better",
        cadence: "daily",
      },
    ],
  },
  Hermes: {
    id: "2b9fda1c-5163-4ab9-9a52-e955e95c93ac",
    accountabilities: [
      {
        name: "comms_response_latency_hours",
        metric: "average hours from message received to response",
        target: 2,
        alert_threshold: 8,         alert_direction: "higher_is_better",
        alert_direction: "lower_is_better",
        cadence: "daily",
      },
      {
        name: "cross_circle_coordination_issues_resolved_weekly",
        metric: "count of coordination issues resolved or escalated this week",
        target: 3,
        alert_threshold: 5,
        alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "weekly",
      },
    ],
  },
  Researcher: {
    id: "54b0194c-dd57-4c43-a7c7-9e3071d2e7d3",
    accountabilities: [
      {
        name: "research_doc_per_assigned_issue",
        metric: "ratio of research documents produced to assigned issues completed",
        target: 1,
        alert_threshold: 0,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "daily",
      },
      {
        name: "research_docs_published_monthly",
        metric: "count of research documents published this month",
        target: 2,
        alert_threshold: 0,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  "PM Coordinator": {
    id: "2172891c-cec4-4886-8a05-afe483fd7061",
    accountabilities: [
      {
        name: "unrouted_backlog_count",
        metric: "count of unassigned backlog issues older than 24h",
        target: 5,
        alert_threshold: 10,         alert_direction: "higher_is_better",
        alert_direction: "lower_is_better",
        cadence: "daily",
      },
      {
        name: "routing_accuracy_rate",
        metric: "ratio of correctly routed issues to total routed issues",
        target: 0.9,
        alert_threshold: 0.7,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "weekly",
      },
    ],
  },
  "Workflow Architect": {
    id: "d3715d54-6c06-4535-abe4-e51523968f38",
    accountabilities: [
      {
        name: "governance_proposal_turnaround_hours",
        metric: "average hours from tension raised to governance proposal filed",
        target: 24,
        alert_threshold: 72,         alert_direction: "higher_is_better",
        alert_direction: "lower_is_better",
        cadence: "daily",
      },
      {
        name: "automation_scripts_deployed_monthly",
        metric: "count of workflow automation scripts deployed this month",
        target: 1,
        alert_threshold: 0,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  // Zombie/legacy agents — minimal placeholder so action 9 scanner can detect them
  Secretary: {
    id: "62c7a2b3-5358-4ce2-99fc-b78cfff974b5",
    accountabilities: [
      {
        name: "agent_active",
        metric: "agent is actively assigned to issues this month",
        target: true,
        alert_threshold: false,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  "Circle Rep": {
    id: "322d0092-a348-4dae-a195-a0dd7e96ecd5",
    accountabilities: [
      {
        name: "agent_active",
        metric: "agent is actively assigned to issues this month",
        target: true,
        alert_threshold: false,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  Facilitator: {
    id: "4d53f137-4eeb-43ff-86c6-2fea42ce849e",
    accountabilities: [
      {
        name: "agent_active",
        metric: "agent is actively assigned to issues this month",
        target: true,
        alert_threshold: false,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  "Doc Lead": {
    id: "1243032c-c03f-4fe7-8b5d-4eb3a77e84db",
    accountabilities: [
      {
        name: "agent_active",
        metric: "agent is actively assigned to issues this month",
        target: true,
        alert_threshold: false,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  "Sales Lead": {
    id: "89c526a5-f886-4bf7-bc0a-fc32f1b00b9e",
    accountabilities: [
      {
        name: "agent_active",
        metric: "agent is actively assigned to issues this month",
        target: true,
        alert_threshold: false,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
  "Growth Lead": {
    id: "c8cd3e0c-de83-4bc6-b568-66651c5e925e",
    accountabilities: [
      {
        name: "agent_active",
        metric: "agent is actively assigned to issues this month",
        target: true,
        alert_threshold: false,         alert_direction: "higher_is_better",
        alert_direction: "higher_is_better",
        cadence: "monthly",
      },
    ],
  },
};

async function updateAgent(id: string, name: string, accountabilities: Accountability[]) {
  const url = `${API_BASE}/companies/46cad2c0-19f3-4a22-95d1-c5f3dcb0f096/agents/${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Paperclip-API-Key": API_KEY,
    },
    body: JSON.stringify({ accountabilities }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`FAIL ${name} (${id}): ${res.status} ${text}`);
    return false;
  }

  const data = await res.json() as { accountabilities?: Accountability[] };
  console.log(`OK   ${name}: ${data.accountabilities?.length ?? 0} accountabilities`);
  return true;
}

async function main() {
  console.log("Backfilling accountabilities for all 14 agents...\n");
  let ok = 0;
  let fail = 0;

  for (const [name, { id, accountabilities }] of Object.entries(AGENTS)) {
    const success = await updateAgent(id, name, accountabilities);
    if (success) ok++;
    else fail++;
  }

  console.log(`\nDone: ${ok} OK, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
