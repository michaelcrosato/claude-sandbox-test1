import { describe, expect, it } from "vitest";
import {
  DataPruner,
  DEFAULT_PRUNER_SWEEP_INTERVAL_MS,
  type DataPrunerOptions,
  type PruneResult,
} from "./data-pruner.js";
import type { DeliveryAttemptStore } from "../attempts/delivery-attempt.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import type { MessageStore } from "../storage/message-store.js";

/**
 * Minimal stub stores that record calls and return controllable values.
 * Only the prune methods are needed here; everything else is unused.
 */
interface StubStores {
  attempts: DeliveryAttemptStore;
  queue: DeliveryQueue;
  messages: MessageStore;
  calls: string[];
  cutoffs: () => { attempts: number | undefined; tasks: number | undefined; messages: number | undefined };
}

function makeStubs(opts: {
  returnAttempts?: number;
  returnTasks?: number;
  returnMessages?: number;
  throwOn?: "attempts" | "tasks" | "messages";
} = {}): StubStores {
  const calls: string[] = [];
  let attemptsCutoff: number | undefined;
  let tasksCutoff: number | undefined;
  let messagesCutoff: number | undefined;

  const attempts = {
    async pruneOldAttempts(cutoffMs: number) {
      calls.push("attempts");
      attemptsCutoff = cutoffMs;
      if (opts.throwOn === "attempts") throw new Error("attempts failed");
      return opts.returnAttempts ?? 0;
    },
  } as unknown as DeliveryAttemptStore;

  const queue = {
    async pruneTerminalTasks(cutoffMs: number) {
      calls.push("tasks");
      tasksCutoff = cutoffMs;
      if (opts.throwOn === "tasks") throw new Error("tasks failed");
      return opts.returnTasks ?? 0;
    },
  } as unknown as DeliveryQueue;

  const messages = {
    async pruneMessages(cutoffMs: number) {
      calls.push("messages");
      messagesCutoff = cutoffMs;
      if (opts.throwOn === "messages") throw new Error("messages failed");
      return opts.returnMessages ?? 0;
    },
  } as unknown as MessageStore;

  return {
    attempts,
    queue,
    messages,
    calls,
    cutoffs: () => ({ attempts: attemptsCutoff, tasks: tasksCutoff, messages: messagesCutoff }),
  };
}

function makePruner(
  stubs: StubStores,
  overrides: Partial<DataPrunerOptions> = {},
): DataPruner {
  return new DataPruner({
    attempts: stubs.attempts,
    queue: stubs.queue,
    messages: stubs.messages,
    retentionDays: 7,
    now: () => 7 * 24 * 60 * 60 * 1_000, // exactly 7 days since epoch → cutoff = 0
    ...overrides,
  });
}

describe("DataPruner", () => {
  describe("constructor", () => {
    it("rejects retentionDays < 1", () => {
      const stubs = makeStubs();
      expect(
        () =>
          new DataPruner({
            attempts: stubs.attempts,
            queue: stubs.queue,
            messages: stubs.messages,
            retentionDays: 0,
          }),
      ).toThrow(RangeError);
      expect(
        () =>
          new DataPruner({
            attempts: stubs.attempts,
            queue: stubs.queue,
            messages: stubs.messages,
            retentionDays: -1,
          }),
      ).toThrow(RangeError);
    });

    it("rejects a non-integer retentionDays", () => {
      const stubs = makeStubs();
      expect(
        () =>
          new DataPruner({
            attempts: stubs.attempts,
            queue: stubs.queue,
            messages: stubs.messages,
            retentionDays: 1.5,
          }),
      ).toThrow(RangeError);
    });

    it("exposes DEFAULT_PRUNER_SWEEP_INTERVAL_MS", () => {
      expect(DEFAULT_PRUNER_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1_000);
    });
  });

  describe("pruneOnce", () => {
    it("prunes all three stores and returns a tally with the correct cutoff", async () => {
      const stubs = makeStubs({ returnAttempts: 3, returnTasks: 2, returnMessages: 5 });
      const nowMs = 10 * 24 * 60 * 60 * 1_000; // 10 days since epoch
      const retentionDays = 7;
      const expectedCutoff = nowMs - retentionDays * 24 * 60 * 60 * 1_000;

      const pruner = makePruner(stubs, { retentionDays, now: () => nowMs });
      const result: PruneResult = await pruner.pruneOnce();

      expect(result.prunedAttempts).toBe(3);
      expect(result.prunedTasks).toBe(2);
      expect(result.prunedMessages).toBe(5);
      expect(result.cutoffMs).toBe(expectedCutoff);
    });

    it("passes the same cutoff to all three stores", async () => {
      const stubs = makeStubs();
      const nowMs = 14 * 24 * 60 * 60 * 1_000;
      const retentionDays = 3;
      const expectedCutoff = nowMs - retentionDays * 24 * 60 * 60 * 1_000;

      const pruner = makePruner(stubs, { retentionDays, now: () => nowMs });
      await pruner.pruneOnce();

      const { attempts, tasks, messages } = stubs.cutoffs();
      expect(attempts).toBe(expectedCutoff);
      expect(tasks).toBe(expectedCutoff);
      expect(messages).toBe(expectedCutoff);
    });

    it("calls the stores in dependency-safe order: attempts → tasks → messages", async () => {
      const stubs = makeStubs();
      const pruner = makePruner(stubs);
      await pruner.pruneOnce();
      expect(stubs.calls).toEqual(["attempts", "tasks", "messages"]);
    });

    it("propagates a store error synchronously to the caller", async () => {
      const stubs = makeStubs({ throwOn: "tasks" });
      const pruner = makePruner(stubs);
      await expect(pruner.pruneOnce()).rejects.toThrow("tasks failed");
    });
  });

  describe("run / stop lifecycle", () => {
    it("runs one sweep then stops when stop() is called from sleep", async () => {
      const stubs = makeStubs({ returnAttempts: 1, returnTasks: 0, returnMessages: 0 });
      let pruner!: DataPruner;
      const sleep = async (): Promise<void> => {
        pruner.stop();
      };
      pruner = makePruner(stubs, { sleep });

      expect(pruner.running).toBe(false);
      await pruner.run();
      expect(pruner.running).toBe(false);
      // Exactly one sweep occurred.
      expect(stubs.calls).toEqual(["attempts", "tasks", "messages"]);
    });

    it("routes a sweep error to onError and continues looping", async () => {
      const stubs = makeStubs({ throwOn: "attempts" });
      const errors: unknown[] = [];
      let iterations = 0;
      let pruner!: DataPruner;
      const sleep = async (): Promise<void> => {
        iterations += 1;
        if (iterations >= 2) pruner.stop();
      };
      pruner = makePruner(stubs, {
        sleep,
        onError: (e) => errors.push(e),
      });

      await pruner.run();
      // Two sweeps; each threw, so onError was called twice.
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toBe("attempts failed");
      expect(pruner.running).toBe(false);
    });

    it("throws if run() is called while already running", async () => {
      const stubs = makeStubs();
      let pruner!: DataPruner;
      const sleep = async (): Promise<void> => {
        await expect(pruner.run()).rejects.toThrow("already running");
        pruner.stop();
      };
      pruner = makePruner(stubs, { sleep });
      await pruner.run();
    });
  });
});
