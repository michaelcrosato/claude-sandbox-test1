import { describe, expect, it } from "vitest";
import { usageReportFromSummary } from "./billing-provider.js";
import type { UsageSummary } from "../storage/message-store.js";

describe("usageReportFromSummary", () => {
  it("maps fields correctly and defaults timestamp to toMs", () => {
    const summary: UsageSummary = {
      appId: "app-123",
      fromMs: 1000,
      toMs: 2000,
      total: 42,
      daily: [],
    };

    const report = usageReportFromSummary(summary, { customerId: "cus_xyz" });

    expect(report).toEqual({
      appId: "app-123",
      customerId: "cus_xyz",
      quantity: 42,
      periodStart: 1000,
      periodEnd: 2000,
      timestamp: 2000,
    });
  });

  it("uses provided timestamp if given", () => {
    const summary: UsageSummary = {
      appId: "app-123",
      fromMs: 1000,
      toMs: 2000,
      total: 42,
      daily: [],
    };

    const report = usageReportFromSummary(summary, { customerId: "cus_xyz", timestamp: 3000 });

    expect(report).toEqual({
      appId: "app-123",
      customerId: "cus_xyz",
      quantity: 42,
      periodStart: 1000,
      periodEnd: 2000,
      timestamp: 3000,
    });
  });
});
