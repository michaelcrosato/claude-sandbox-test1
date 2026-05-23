import { describe, expect, it } from "vitest";
import {
  MetricsRegistry,
  renderPrometheus,
  PROMETHEUS_CONTENT_TYPE,
  type MetricsSnapshot,
} from "./metrics.js";
import type { TickResult } from "../worker/delivery-worker.js";

/** Build a TickResult, defaulting the unset tallies to 0. */
function tick(partial: Partial<TickResult>): TickResult {
  return {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
    stale: 0,
    ...partial,
  };
}

describe("MetricsRegistry", () => {
  it("starts at zero with the given version", () => {
    const reg = new MetricsRegistry({ version: "1.2.3", now: () => 0 });
    expect(reg.version).toBe("1.2.3");
    expect(reg.counters()).toEqual({
      messagesIngested: 0,
      messagesDeduplicated: 0,
      deliveries: { succeeded: 0, failed: 0, deadLettered: 0, stale: 0 },
    });
  });

  it("defaults the version to 'unknown'", () => {
    expect(new MetricsRegistry().version).toBe("unknown");
  });

  it("counts ingests and tracks deduplicated separately", () => {
    const reg = new MetricsRegistry();
    reg.recordIngest({ deduplicated: false });
    reg.recordIngest({ deduplicated: true });
    reg.recordIngest({ deduplicated: false });
    const counters = reg.counters();
    expect(counters.messagesIngested).toBe(3);
    expect(counters.messagesDeduplicated).toBe(1);
  });

  it("accumulates delivery outcomes across ticks", () => {
    const reg = new MetricsRegistry();
    reg.recordTick(tick({ claimed: 2, succeeded: 1, failed: 1 }));
    reg.recordTick(tick({ claimed: 2, succeeded: 1, deadLettered: 1 }));
    reg.recordTick(tick({ claimed: 1, stale: 1 }));
    expect(reg.counters().deliveries).toEqual({
      succeeded: 2,
      failed: 1,
      deadLettered: 1,
      stale: 1,
    });
  });

  it("recordTick / recordIngest stay bound when passed as bare callbacks", () => {
    const reg = new MetricsRegistry();
    // The whole point of the arrow-bound methods: usable as `onTick`/callbacks.
    const onTick = reg.recordTick;
    const onIngest = reg.recordIngest;
    onTick(tick({ succeeded: 1 }));
    onIngest({ deduplicated: false });
    expect(reg.counters().deliveries.succeeded).toBe(1);
    expect(reg.counters().messagesIngested).toBe(1);
  });

  it("computes uptime from the injected clock and never goes negative", () => {
    let now = 10_000;
    const reg = new MetricsRegistry({ now: () => now });
    expect(reg.uptimeSeconds()).toBe(0);
    now = 12_500;
    expect(reg.uptimeSeconds()).toBe(2.5);
    // A clock that goes backwards (e.g. an NTP step) clamps to 0, never negative.
    now = 9_000;
    expect(reg.uptimeSeconds()).toBe(0);
  });
});

describe("renderPrometheus", () => {
  const snapshot: MetricsSnapshot = {
    version: "0.0.1",
    uptimeSeconds: 12.5,
    counters: {
      messagesIngested: 42,
      messagesDeduplicated: 3,
      deliveries: { succeeded: 39, failed: 5, deadLettered: 1, stale: 0 },
    },
    deliveryTasksByStatus: {
      pending: 2,
      delivering: 1,
      succeeded: 39,
      dead_letter: 1,
    },
  };

  it("emits HELP and TYPE lines for every family", () => {
    const text = renderPrometheus(snapshot);
    for (const name of [
      "posthorn_build_info",
      "posthorn_uptime_seconds",
      "posthorn_messages_ingested_total",
      "posthorn_messages_deduplicated_total",
      "posthorn_deliveries_total",
      "posthorn_delivery_tasks",
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it("renders counters and gauges with the right values and types", () => {
    const text = renderPrometheus(snapshot);
    expect(text).toContain("# TYPE posthorn_messages_ingested_total counter");
    expect(text).toContain("posthorn_messages_ingested_total 42");
    expect(text).toContain("posthorn_messages_deduplicated_total 3");
    expect(text).toContain("# TYPE posthorn_uptime_seconds gauge");
    expect(text).toContain("posthorn_uptime_seconds 12.5");
    expect(text).toContain('posthorn_build_info{version="0.0.1"} 1');
  });

  it("renders the delivery-outcome counter as a labeled series", () => {
    const text = renderPrometheus(snapshot);
    expect(text).toContain('posthorn_deliveries_total{outcome="succeeded"} 39');
    expect(text).toContain('posthorn_deliveries_total{outcome="failed"} 5');
    expect(text).toContain('posthorn_deliveries_total{outcome="dead_lettered"} 1');
    expect(text).toContain('posthorn_deliveries_total{outcome="stale"} 0');
  });

  it("renders the backlog gauge with one series per status", () => {
    const text = renderPrometheus(snapshot);
    expect(text).toContain('posthorn_delivery_tasks{status="pending"} 2');
    expect(text).toContain('posthorn_delivery_tasks{status="delivering"} 1');
    expect(text).toContain('posthorn_delivery_tasks{status="succeeded"} 39');
    expect(text).toContain('posthorn_delivery_tasks{status="dead_letter"} 1');
  });

  it("ends with a trailing newline (exposition format requirement)", () => {
    expect(renderPrometheus(snapshot).endsWith("\n")).toBe(true);
  });

  it("escapes special characters in label values", () => {
    const text = renderPrometheus({
      ...snapshot,
      version: 'a"b\\c',
    });
    expect(text).toContain('posthorn_build_info{version="a\\"b\\\\c"} 1');
  });

  it("advertises the v0.0.4 text exposition content type", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
