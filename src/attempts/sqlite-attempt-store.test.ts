import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDeliveryAttemptStore } from "./sqlite-attempt-store.js";
import {
  describeDeliveryAttemptStoreContract,
  makeAttemptConformanceIds,
} from "./conformance.js";

// The SQLite backend must satisfy the exact same contract as the reference
// in-memory store. Conformance runs against an ephemeral `:memory:` database.
describeDeliveryAttemptStoreContract(
  "SqliteDeliveryAttemptStore",
  (options) => new SqliteDeliveryAttemptStore(options),
);

describe("SqliteDeliveryAttemptStore — durability", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posthorn-attempts-"));
    dbPath = join(dir, "attempts.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists recorded attempts across a reopen", async () => {
    const ids = makeAttemptConformanceIds();
    const before = new SqliteDeliveryAttemptStore({
      location: dbPath,
      generateId: ids.generateId,
    });
    await before.record({
      taskId: "t1",
      messageId: "m1",
      appId: "app_xyz",
      endpointId: "ep_1",
      attemptNumber: 1,
      outcome: "failed",
      responseStatus: 500,
      error: "boom",
      durationMs: 9,
      attemptedAt: 1_700_000_000_000,
    });
    expect(before.size).toBe(1);
    before.close();

    // Reattach to the same file: the audit record survives, tenant attribution included.
    const after = new SqliteDeliveryAttemptStore({ location: dbPath });
    try {
      expect(after.size).toBe(1);
      const [survived] = await after.listByMessage("m1");
      expect(survived).toEqual({
        id: "datt_test_1",
        taskId: "t1",
        messageId: "m1",
        appId: "app_xyz",
        endpointId: "ep_1",
        attemptNumber: 1,
        outcome: "failed",
        responseStatus: 500,
        error: "boom",
        durationMs: 9,
        attemptedAt: 1_700_000_000_000,
      });
      // And per-tenant delivery usage reads back across the reopen.
      const usage = await after.summarizeAttemptsByApp("app_xyz", {
        fromMs: 1_700_000_000_000,
        toMs: 1_700_000_000_001,
      });
      expect(usage.total).toBe(1);
      expect(usage.failed).toBe(1);
    } finally {
      after.close();
    }
  });

  it("keeps independent stores isolated to their own files", async () => {
    const a = new SqliteDeliveryAttemptStore({ location: join(dir, "a.sqlite") });
    const b = new SqliteDeliveryAttemptStore({ location: join(dir, "b.sqlite") });
    try {
      await a.record({
        taskId: "t",
        messageId: "m",
        attemptNumber: 1,
        outcome: "succeeded",
        durationMs: 0,
        attemptedAt: 1,
      });
      expect((await a.listByMessage("m")).length).toBe(1);
      expect((await b.listByMessage("m")).length).toBe(0);
      expect(b.size).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
