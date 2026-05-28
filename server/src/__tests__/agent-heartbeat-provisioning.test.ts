import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeConfigForNewAgent,
  enforceHeartbeatEnabledOnUpdate,
} from "../services/agents.ts";

describe("normalizeRuntimeConfigForNewAgent — heartbeat provisioning invariant", () => {
  it("sets heartbeat.enabled=true when not provided", () => {
    const result = normalizeRuntimeConfigForNewAgent({});
    expect((result.heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("forces heartbeat.enabled=true even when caller passes false", () => {
    const result = normalizeRuntimeConfigForNewAgent({
      heartbeat: { enabled: false },
    });
    expect((result.heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("forces heartbeat.enabled=true when caller passes null", () => {
    const result = normalizeRuntimeConfigForNewAgent({
      heartbeat: { enabled: null },
    });
    expect((result.heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("preserves heartbeat.enabled=true when already true", () => {
    const result = normalizeRuntimeConfigForNewAgent({
      heartbeat: { enabled: true, intervalSec: 60 },
    });
    const hb = result.heartbeat as Record<string, unknown>;
    expect(hb.enabled).toBe(true);
    expect(hb.intervalSec).toBe(60);
  });

  it("sets default maxConcurrentRuns when not provided", () => {
    const result = normalizeRuntimeConfigForNewAgent({});
    const hb = result.heartbeat as Record<string, unknown>;
    expect(typeof hb.maxConcurrentRuns).toBe("number");
  });

  it("preserves other runtimeConfig keys", () => {
    const result = normalizeRuntimeConfigForNewAgent({
      someFeatureFlag: true,
      heartbeat: { enabled: false },
    });
    expect(result.someFeatureFlag).toBe(true);
    expect((result.heartbeat as Record<string, unknown>).enabled).toBe(true);
  });
});

describe("enforceHeartbeatEnabledOnUpdate — provisioning invariant on patch", () => {
  it("returns undefined when runtimeConfig not in patch", () => {
    const result = enforceHeartbeatEnabledOnUpdate({}, undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined when patch has no heartbeat key", () => {
    const result = enforceHeartbeatEnabledOnUpdate(
      { heartbeat: { enabled: true } },
      { someOtherKey: "value" },
    );
    expect(result).toBeUndefined();
  });

  it("auto-corrects heartbeat.enabled=false to true", () => {
    const result = enforceHeartbeatEnabledOnUpdate(
      { heartbeat: { enabled: true } },
      { heartbeat: { enabled: false, intervalSec: 30 } },
    );
    expect(result).toBeDefined();
    const hb = (result as Record<string, unknown>).heartbeat as Record<string, unknown>;
    expect(hb.enabled).toBe(true);
    expect(hb.intervalSec).toBe(30);
  });

  it("auto-corrects heartbeat.enabled=null to true", () => {
    const result = enforceHeartbeatEnabledOnUpdate(
      { heartbeat: { enabled: true } },
      { heartbeat: { enabled: null } },
    );
    expect(result).toBeDefined();
    expect(
      ((result as Record<string, unknown>).heartbeat as Record<string, unknown>).enabled,
    ).toBe(true);
  });

  it("preserves heartbeat.enabled=true unchanged", () => {
    const result = enforceHeartbeatEnabledOnUpdate(
      { heartbeat: { enabled: true } },
      { heartbeat: { enabled: true, intervalSec: 60 } },
    );
    // When already true, still returns corrected object (no mutation needed but still returns)
    if (result !== undefined) {
      const hb = (result as Record<string, unknown>).heartbeat as Record<string, unknown>;
      expect(hb.enabled).toBe(true);
    }
    // Either undefined (no change needed) or truthy with enabled=true are both valid
    expect(result === undefined || (result as Record<string, unknown>).heartbeat !== undefined).toBe(true);
  });

  it("preserves non-heartbeat keys in runtimeConfig patch", () => {
    const result = enforceHeartbeatEnabledOnUpdate(
      {},
      { someFlag: true, heartbeat: { enabled: false } },
    );
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).someFlag).toBe(true);
  });

  it("returns undefined when patchRuntimeConfig is not a plain object", () => {
    expect(enforceHeartbeatEnabledOnUpdate({}, null)).toBeUndefined();
    expect(enforceHeartbeatEnabledOnUpdate({}, "string")).toBeUndefined();
    expect(enforceHeartbeatEnabledOnUpdate({}, [])).toBeUndefined();
  });
});
