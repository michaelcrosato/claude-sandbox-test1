import { describe, expect, it } from "vitest";
import { usageReportFromSummary } from "./billing-provider.js";
import type { UsageSummary } from "../storage/message-store.js";

describe("usageReportFromSummary", () => {
  const mockSummary: UsageSummary = {
    appId: "app_123",
    fromMs: 1000,
    toMs: 2000,
    total: 42,
    daily: [],
  };

  it("maps summary and opts to a UsageReport, defaulting timestamp to toMs", () => {
    const report = usageReportFromSummary(mockSummary, { customerId: "cus_abc" });

    expect(report).toEqual({
      appId: "app_123",
      customerId: "cus_abc",
      quantity: 42,
      periodStart: 1000,
      periodEnd: 2000,
      timestamp: 2000, // defaults to toMs
    });
  });

  it("uses the provided timestamp if given", () => {
    const report = usageReportFromSummary(mockSummary, {
      customerId: "cus_abc",
      timestamp: 3000,
    });

    expect(report).toEqual({
      appId: "app_123",
      customerId: "cus_abc",
      quantity: 42,
      periodStart: 1000,
      periodEnd: 2000,
      timestamp: 3000, // overridden by opts.timestamp
    });
  });
});
