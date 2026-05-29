/**
 * Unit tests for the pure plan catalog (`plan.ts`): the tier ids, the frozen
 * entitlement presets, and the `isPlanId` / `normalizePlan` / `entitlementsForPlan`
 * helpers every backend shares to keep plan intake from drifting.
 */

import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  PLAN_IDS,
  entitlementsForPlan,
  isPlanId,
  normalizePlan,
} from "./plan.js";

describe("PLAN_CATALOG", () => {
  it("defines an entry for every plan id, all with concrete (non-null) numbers", () => {
    for (const id of PLAN_IDS) {
      const e = PLAN_CATALOG[id];
      expect(e).toBeDefined();
      expect(typeof e.monthlyMessageQuota).toBe("number");
      expect(typeof e.retentionDays).toBe("number");
      expect(typeof e.rateLimitPerMinute).toBe("number");
    }
  });

  it("forms an ascending freemium ladder on every lever", () => {
    const quotas = PLAN_IDS.map((id) => PLAN_CATALOG[id].monthlyMessageQuota as number);
    const retention = PLAN_IDS.map((id) => PLAN_CATALOG[id].retentionDays as number);
    const rates = PLAN_IDS.map((id) => PLAN_CATALOG[id].rateLimitPerMinute as number);
    for (const ladder of [quotas, retention, rates]) {
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i]).toBeGreaterThan(ladder[i - 1]!);
      }
    }
  });

  it("is frozen so a caller cannot mutate a shared preset", () => {
    expect(Object.isFrozen(PLAN_CATALOG)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG.free)).toBe(true);
  });
});

describe("isPlanId", () => {
  it("accepts each catalog tier and rejects everything else", () => {
    for (const id of PLAN_IDS) {
      expect(isPlanId(id)).toBe(true);
    }
    for (const bad of ["enterprise", "", "FREE", null, undefined, 1, {}]) {
      expect(isPlanId(bad)).toBe(false);
    }
  });
});

describe("normalizePlan", () => {
  it("collapses absent/null to null (custom/unmanaged)", () => {
    expect(normalizePlan(undefined)).toBeNull();
    expect(normalizePlan(null)).toBeNull();
  });

  it("passes a valid tier through", () => {
    expect(normalizePlan("pro")).toBe("pro");
  });

  it("throws TypeError on an unknown tier", () => {
    expect(() => normalizePlan("enterprise")).toThrow(TypeError);
    expect(() => normalizePlan(7)).toThrow(TypeError);
  });
});

describe("entitlementsForPlan", () => {
  it("returns null for a custom (null) plan", () => {
    expect(entitlementsForPlan(null)).toBeNull();
  });

  it("returns the frozen catalog entry for a named tier", () => {
    expect(entitlementsForPlan("scale")).toBe(PLAN_CATALOG.scale);
  });
});
