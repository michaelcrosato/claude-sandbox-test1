import { describe, expect, it } from "vitest";

import { runThroughputBench } from "./throughput.js";

// The benchmark's correctness contract, not its speed: a small bounded run must drive every
// message through ingest *and* delivery and return finite, positive rates. Absolute
// throughput is deliberately NOT asserted — that would be flaky across machines/CI. The
// generous settle budget plus the small message count keep this green and non-flaky while
// still exercising the whole pipeline (gateway boot, fan-out, queue drain, signing, HTTP).
describe("runThroughputBench", () => {
  it(
    "drives every message through ingest and delivery, reporting finite positive rates",
    async () => {
      const messages = 25;
      const result = await runThroughputBench({
        messages,
        payloadBytes: 128,
        ingestConcurrency: 10,
        workerConcurrency: 8,
        workerBatchSize: 16,
        settleTimeoutMs: 15_000,
      });

      expect(result.messages).toBe(messages);
      expect(result.payloadBytes).toBe(128);

      // Every send was accepted (202) and every webhook was delivered to the receiver.
      expect(result.ingest.count).toBe(messages);
      expect(result.delivery.count).toBe(messages);
      expect(result.delivery.succeeded).toBe(messages);

      // Rates are finite and positive (the run took real, non-zero time).
      for (const rate of [result.ingest.perSec, result.delivery.perSec]) {
        expect(Number.isFinite(rate)).toBe(true);
        expect(rate).toBeGreaterThan(0);
      }
      expect(result.ingest.elapsedMs).toBeGreaterThan(0);
      expect(result.delivery.elapsedMs).toBeGreaterThan(0);
    },
    30_000,
  );

  it("rejects a non-positive message count", async () => {
    await expect(runThroughputBench({ messages: 0 })).rejects.toThrow(TypeError);
    await expect(runThroughputBench({ messages: -5 })).rejects.toThrow(TypeError);
  });
});
