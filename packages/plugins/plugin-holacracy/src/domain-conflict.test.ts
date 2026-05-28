/**
 * MYA-113: Domain registry + CI conflict check
 *
 * Acceptance Criteria:
 * - Domain registry schema defined (roles → domain sets) ✓ (migration 004)
 * - CI check rejects assignments where role domains conflict ✓
 * - Integrated into holacracy MCP role-assignment flow ✓
 *   (assignRole + updateRole + updateRoleAssignment all call checkDomainConflict)
 * - Test case: verify Sales + Growth + Doc Lead cannot coexist on one agent ✓
 *
 * This suite exercises the integration end-to-end against a running
 * Paperclip instance with the holacracy plugin enabled.
 *
 * NOTE: registry domain names are lowercase (sales/growth/documentation).
 */

import { describe, it, expect, beforeEach } from "vitest";

const API_BASE = process.env.PAPERCLIP_API_BASE ?? "http://localhost:3101";
const API_KEY = process.env.PAPERCLIP_API_KEY ?? "local-trusted-key";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096";
const TEST_AGENT_ID = process.env.MYA_TEST_AGENT_ID ?? "2b9fda1c-5163-4ab9-9a52-e955e95c93ac";

const HEADERS = {
  "Content-Type": "application/json",
  "X-Paperclip-API-Key": API_KEY,
};

async function createCircle(name: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/plugins/paperclipai.plugin-holacracy/api/circles`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      companyId: COMPANY_ID,
      name,
      purpose: "domain conflict test fixture",
    }),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  return data.id;
}

async function assignRole(circleId: string, roleName: string, domains: string[], agentId: string) {
  return fetch(`${API_BASE}/api/plugins/paperclipai.plugin-holacracy/api/circles/${circleId}/roles`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      companyId: COMPANY_ID,
      roleName,
      roleType: "custom",
      purpose: `${roleName} test role`,
      accountabilities: [],
      domains,
      agentId,
    }),
  });
}

describe("MYA-113: Domain Registry Conflict Check", () => {
  let circleId: string;

  beforeEach(async () => {
    circleId = await createCircle(`domain-conflict-test-${Date.now()}`);
  });

  it("rejects growth assignment when agent already holds sales", async () => {
    const salesRes = await assignRole(circleId, "Sales Lead", ["sales"], TEST_AGENT_ID);
    expect(salesRes.status).toBe(201);

    const growthRes = await assignRole(circleId, "Growth Lead", ["growth"], TEST_AGENT_ID);
    expect(growthRes.status).toBe(409);
    const errBody = await growthRes.json();
    expect(errBody.error).toMatch(/Domain conflict/);
  });

  it("rejects documentation when agent already holds sales", async () => {
    const salesRes = await assignRole(circleId, "Sales Rep", ["sales"], TEST_AGENT_ID);
    expect(salesRes.status).toBe(201);

    const docRes = await assignRole(circleId, "Doc Lead", ["documentation"], TEST_AGENT_ID);
    expect(docRes.status).toBe(409);
  });

  it("Sales + Growth + Doc Lead cannot coexist on one agent", async () => {
    const salesRes = await assignRole(circleId, "Sales", ["sales"], TEST_AGENT_ID);
    expect(salesRes.status).toBe(201);

    const growthRes = await assignRole(circleId, "Growth", ["growth"], TEST_AGENT_ID);
    expect(growthRes.status).toBe(409);

    const docRes = await assignRole(circleId, "Doc Lead", ["documentation"], TEST_AGENT_ID);
    expect(docRes.status).toBe(409);
  });

  it("rejects multi-domain role that combines conflicts in single assignment", async () => {
    const res = await assignRole(circleId, "Combined", ["sales", "growth"], TEST_AGENT_ID);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Domain conflict/);
  });

  it("allows non-conflicting domain pair (sales + engineering)", async () => {
    const salesRes = await assignRole(circleId, "Sales", ["sales"], TEST_AGENT_ID);
    expect(salesRes.status).toBe(201);

    const engRes = await assignRole(circleId, "Eng Lead", ["engineering"], TEST_AGENT_ID);
    expect(engRes.status).toBe(201);
  });
});
