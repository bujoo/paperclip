/**
 * Accountability Scanner integration tests — MYA-78
 *
 * Runs against the live dev server on port 3101.
 * Uses the plugin API route POST /accountability-scan
 * with companyId = real company UUID.
 *
 * Tests:
 * 1. Scanner returns 200 with expected shape
 * 2. Deliberately breached metric (engineering_issues_completed_weekly threshold=9999)
 *    produces exactly one tension
 * 3. Running scanner a second time same day does NOT duplicate tension (idempotency)
 * 4. Tension appears in holacracyListTensions for the agent's circle
 * 5. Audit log entry visible for GCC
 */

import { describe, it, expect, beforeAll } from "vitest";

const API_BASE = "http://localhost:3101";
const PLUGIN_ID = "b04c5f66-ca71-4e1c-8a16-d4ab1d4bc602";
const COMPANY_ID = "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096";
const API_KEY = "local-trusted-key";
const GCC_CIRCLE_ID = "86948526-54dc-4662-b952-e3225ff5727a";
// Dev Lead agent — has engineering_issues_completed_weekly with threshold=9999 (always breaches)
const DEV_LEAD_AGENT_ID = "e1f66962-dc3c-4a8e-9875-de1a1dee2839";

const pluginApiUrl = (path: string) =>
  `${API_BASE}/api/plugins/${PLUGIN_ID}/api${path}?companyId=${COMPANY_ID}`;

async function apiGet(path: string) {
  const res = await fetch(pluginApiUrl(path), {
    headers: { "X-Paperclip-API-Key": API_KEY },
  });
  return res.json();
}

async function runScan(scanDate?: string) {
  const body: Record<string, string> = { companyId: COMPANY_ID };
  if (scanDate) body.scanDate = scanDate;
  const res = await fetch(`${API_BASE}/api/plugins/${PLUGIN_ID}/api/accountability-scan?companyId=${COMPANY_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Paperclip-API-Key": API_KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Use a unique past date so tests don't collide with real daily scans
const TEST_SCAN_DATE = "2024-01-15"; // Monday, 15th = weekly + monthly due

describe("accountability scanner", () => {
  beforeAll(async () => {
    // Clean up any tensions from a prior test run with the same date
    // by resolving them first (can't delete via API, but idempotency check will skip them)
    // We'll use a unique date to avoid collisions.
  });

  it("returns 200 with expected shape", async () => {
    const { status, body } = await runScan(TEST_SCAN_DATE);
    expect(status).toBe(200);
    expect(body).toHaveProperty("scanDate", TEST_SCAN_DATE);
    expect(body).toHaveProperty("agentsScanned");
    expect(body).toHaveProperty("tensionsRaised");
    expect(body).toHaveProperty("tensionsSkipped");
    expect(body).toHaveProperty("raised");
    expect(body).toHaveProperty("skipped");
    expect(typeof body.agentsScanned).toBe("number");
    expect(body.agentsScanned).toBeGreaterThan(0);
  }, 15000);

  it("Dev Lead engineering_issues_completed_weekly (threshold=9999) produces a tension", async () => {
    const { status, body } = await runScan(TEST_SCAN_DATE);
    expect(status).toBe(200);

    // Dev Lead should have at least one tension raised (threshold 9999 always breaches)
    const devLeadRaised = body.raised.filter(
      (t: { agentId: string; accountability: string }) =>
        t.agentId === DEV_LEAD_AGENT_ID && t.accountability === "engineering_issues_completed_weekly",
    );
    // First run: 1 raised or already skipped (if this test ran before)
    const devLeadSkipped = body.skipped.filter(
      (t: { agentId: string; accountability: string; reason: string }) =>
        t.agentId === DEV_LEAD_AGENT_ID &&
        t.accountability === "engineering_issues_completed_weekly" &&
        t.reason === "duplicate",
    );
    expect(devLeadRaised.length + devLeadSkipped.length).toBe(1);
  }, 15000);

  it("second scan same day deduplicates — no new tensions", async () => {
    // First scan
    await runScan(TEST_SCAN_DATE);
    // Second scan same date
    const { status, body } = await runScan(TEST_SCAN_DATE);
    expect(status).toBe(200);
    expect(body.tensionsRaised).toBe(0);
    expect(body.tensionsSkipped).toBeGreaterThan(0);
    const allDupes = body.skipped.every(
      (s: { reason: string }) => s.reason === "duplicate" || s.reason === "unknown_metric",
    );
    expect(allDupes).toBe(true);
  }, 20000);

  it("raised tension appears in holacracyListTensions for Engineering circle", async () => {
    // Run scan to ensure tension exists
    await runScan(TEST_SCAN_DATE);

    // Find Engineering circle
    const circles = await apiGet("/circles");
    const engCircle = circles.find((c: { name: string }) => c.name === "Engineering");
    expect(engCircle).toBeDefined();

    const tensionsData = await fetch(pluginApiUrl(`/circles/${engCircle.id}/tensions`), {
      headers: { "X-Paperclip-API-Key": API_KEY },
    }).then((r) => r.json());
    const tensions = tensionsData.tensions ?? tensionsData;

    const scannerTensions = tensions.filter(
      (t: { title: string }) => t.title.startsWith("[Scanner]") && t.title.includes("Dev Lead"),
    );
    expect(scannerTensions.length).toBeGreaterThan(0);
  }, 15000);

  it("audit log shows accountability-scanner tension-raised entry for GCC", async () => {
    await runScan(TEST_SCAN_DATE);

    const auditLog = await apiGet(`/circles/${GCC_CIRCLE_ID}/audit-log`);
    const entries = Array.isArray(auditLog) ? auditLog : auditLog.entries ?? [];
    const scannerEntries = entries.filter((e: { action_detail: string }) => {
      try {
        const detail = typeof e.action_detail === "string" ? JSON.parse(e.action_detail) : e.action_detail;
        return detail?.source === "accountability-scanner";
      } catch {
        return false;
      }
    });
    expect(scannerEntries.length).toBeGreaterThan(0);
  }, 15000);
});
