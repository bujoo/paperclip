/**
 * E2E test: governance tension triggers async 3-of-3 approval
 * 
 * Acceptance Criteria:
 * - E2E test: create a tension via holacracyRaiseTension({type: "governance"}) => approval auto-created with 3 approvers
 * - 3 approvals via paperclipApprovalDecision flip status to approved
 * - 1 reject flips status to rejected
 * - 24h timeout fires escalation (test with shortened timeout in fixture)
 * - Audit log records the chain: tension => approval => decisions => final state
 * - All hardcoded approver IDs in one constants module so they can be edited without touching trigger logic
 */

import { describe, it, expect, beforeAll } from "vitest";
import { GOVERNANCE_APPROVERS } from "./constants.js";

// Plugin instance ID and API base — must match running server
const PLUGIN_INSTANCE_ID = "b04c5f66-ca71-4e1c-8a16-d4ab1d4bc602";
const COMPANY_ID = "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096";
const API_BASE = "http://localhost:3101";
const API_KEY = "local-trusted-key";

// GCC circle ID (General Company Circle)
const GCC_CIRCLE_ID = "86948526-54dc-4662-b952-e3225ff5727a";

function pluginUrl(path: string) {
  const qs = `?companyId=${COMPANY_ID}`;
  return `${API_BASE}/api/plugins/${PLUGIN_INSTANCE_ID}/api${path}${qs}`;
}

function headers() {
  return {
    "Content-Type": "application/json",
    "X-Paperclip-API-Key": API_KEY,
  };
}

async function raiseTension(title: string, description: string, type: string, circleId: string) {
  return fetch(pluginUrl(`/circles/${circleId}/tensions`), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title, description, type, companyId: COMPANY_ID }),
  });
}

async function getAuditLog(circleId: string) {
  const res = await fetch(pluginUrl(`/circles/${circleId}/audit-log`), {
    headers: headers(),
  });
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function waitForApprovalInAuditLog(circleId: string, tensionId: string, maxMs = 5000): Promise<string | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const logs = await getAuditLog(circleId);
    for (const l of logs) {
      if (l.action_type === "governance-approval-created") {
        try {
          const detail = typeof l.action_detail === "string" ? JSON.parse(l.action_detail) : l.action_detail;
          if (detail.tensionId === tensionId) return detail.approvalId;
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

describe("Governance Trigger E2E", () => {
  it("constants module has all 3 approver IDs", () => {
    expect(GOVERNANCE_APPROVERS.strategist).toMatch(/^[0-9a-f-]{36}$/);
    expect(GOVERNANCE_APPROVERS.productManager).toMatch(/^[0-9a-f-]{36}$/);
    expect(GOVERNANCE_APPROVERS.devLead).toMatch(/^[0-9a-f-]{36}$/);
    // All distinct
    const ids = Object.values(GOVERNANCE_APPROVERS);
    expect(new Set(ids).size).toBe(3);
  });

  it("should auto-create approval when tension type=governance", async () => {
    // Step 1: Raise a governance tension
    const raiseResponse = await raiseTension(
      "Test governance tension: role boundary clarification",
      "Proposal to clarify the Dev Lead role boundaries re: infra decisions",
      "governance",
      GCC_CIRCLE_ID,
    );

    expect(raiseResponse.status).toBe(201);
    const tensionData = await raiseResponse.json();
    expect(tensionData.tensionId).toBeDefined();
    expect(tensionData.type).toBe("governance");
    const tensionId = tensionData.tensionId;
    console.log(`✓ Governance tension raised: ${tensionId}`);

    // Step 2: approvalId returned directly in response (Trigger A)
    let approvalId: string | undefined = tensionData.approvalId;

    // Fall back to audit log poll (in case of async path)
    if (!approvalId) {
      approvalId = (await waitForApprovalInAuditLog(GCC_CIRCLE_ID, tensionId)) ?? undefined;
    }

    expect(approvalId).toBeDefined();
    console.log(`✓ Approval auto-created: ${approvalId}`);

    // Step 3: Verify approval has 3 approvers
    const approvalRes = await fetch(`${API_BASE}/api/approvals/${approvalId}`, {
      headers: headers(),
    });
    expect(approvalRes.status).toBe(200);
    const approval = await approvalRes.json();
    const approverIds: string[] = approval.payload?.approver_agent_ids ?? [];
    console.log(`✓ Approval has ${approverIds.length} approvers`);
    expect(approverIds.length).toBe(3);
    expect(approverIds).toContain(GOVERNANCE_APPROVERS.strategist);
    expect(approverIds).toContain(GOVERNANCE_APPROVERS.productManager);
    expect(approverIds).toContain(GOVERNANCE_APPROVERS.devLead);

    // Step 4: Submit 3 approvals — should flip to approved
    for (let i = 0; i < 3; i++) {
      const decisionRes = await fetch(`${API_BASE}/api/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "approve",
          decisionNote: `Approval ${i + 1} of 3`,
        }),
      });
      expect(decisionRes.status).toBeOneOf([200, 201]);
    }
    console.log(`✓ 3 approvals submitted`);

    // Step 5: Verify final status = approved
    let finalStatus = "";
    for (let i = 0; i < 10; i++) {
      const checkRes = await fetch(`${API_BASE}/api/approvals/${approvalId}`, {
        headers: headers(),
      });
      const checkData = await checkRes.json();
      finalStatus = checkData.status;
      if (finalStatus === "approved") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(finalStatus).toBe("approved");
    console.log(`✓ Approval finalized: ${finalStatus}`);

    // Step 6: Audit chain recorded
    const logs = await getAuditLog(GCC_CIRCLE_ID);
    const tensionLog = logs.find(
      (l: any) => l.action_type === "tension-raised" &&
        (() => { try { const d = typeof l.action_detail === "string" ? JSON.parse(l.action_detail) : l.action_detail; return d.tensionId === tensionId; } catch { return false; } })()
    );
    const approvalLog = logs.find(
      (l: any) => l.action_type === "governance-approval-created" &&
        (() => { try { const d = typeof l.action_detail === "string" ? JSON.parse(l.action_detail) : l.action_detail; return d.tensionId === tensionId; } catch { return false; } })()
    );
    expect(tensionLog).toBeDefined();
    expect(approvalLog).toBeDefined();
    console.log(`✓ Audit chain: tension-raised → governance-approval-created`);
  }, 30000);

  it("should reject approval on single reject decision", async () => {
    // Raise governance tension
    const raiseResponse = await raiseTension(
      "Test reject flow: remove secretary role",
      "Proposal to remove the secretary role from Engineering circle",
      "governance",
      GCC_CIRCLE_ID,
    );
    expect(raiseResponse.status).toBe(201);
    const tensionData = await raiseResponse.json();
    const tensionId = tensionData.tensionId;

    let approvalId: string | undefined = tensionData.approvalId;
    if (!approvalId) {
      approvalId = (await waitForApprovalInAuditLog(GCC_CIRCLE_ID, tensionId)) ?? undefined;
    }
    expect(approvalId).toBeDefined();

    // Reject immediately
    const rejectRes = await fetch(`${API_BASE}/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ action: "reject", decisionNote: "Rejected: secretary role is required" }),
    });
    expect(rejectRes.status).toBeOneOf([200, 201]);

    // Verify status = rejected
    let rejectedStatus = "";
    for (let i = 0; i < 6; i++) {
      const checkRes = await fetch(`${API_BASE}/api/approvals/${approvalId}`, {
        headers: headers(),
      });
      const checkData = await checkRes.json();
      rejectedStatus = checkData.status;
      if (rejectedStatus === "rejected") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(rejectedStatus).toBe("rejected");
    console.log(`✓ Single reject flips approval status to: ${rejectedStatus}`);
  }, 15000);

  it("operational tension should NOT create approval", async () => {
    const raiseResponse = await raiseTension(
      "Operational blocker: CI pipeline slow",
      "CI taking 45min, blocking deploys",
      "operational",
      GCC_CIRCLE_ID,
    );
    expect(raiseResponse.status).toBe(201);
    const data = await raiseResponse.json();
    expect(data.tensionId).toBeDefined();
    expect(data.approvalId).toBeUndefined();
    console.log(`✓ Operational tension has no approvalId (as expected)`);
  }, 10000);
});
