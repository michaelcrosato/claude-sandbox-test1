import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDeliveryAttemptStore } from "./sqlite-attempt-store.js";
import {
  describeDeliveryAttemptStoreContract,
  makeAttemptConformanceIds,
} from "./conformance.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

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
      failureReason: "http_5xx",
      durationMs: 9,
      attemptedAt: 1_700_000_000_000,
    });
    expect(before.size).toBe(1);
    before.close();

    // Reattach to the same file: the audit record survives, tenant attribution included.
    const after = new SqliteDeliveryAttemptStore({ location: dbPath });
    try {
      expect(after.size).toBe(1);
      const { data: survivedData } = await after.listByMessage("m1");
      const [survived] = survivedData;
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
        failureReason: "http_5xx",
        requestBody: null,
        responseBody: null,
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

  it("seamlessly migrates a pre-failure_reason database (adds the column, old rows read null)", async () => {
    // Hand-build a database at the schema *just before* failure_reason shipped: every
    // column the store needs except failure_reason. Insert one legacy row directly.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE delivery_attempts (
        id              TEXT    PRIMARY KEY,
        task_id         TEXT    NOT NULL,
        message_id      TEXT    NOT NULL,
        app_id          TEXT,
        endpoint_id     TEXT,
        attempt_number  INTEGER NOT NULL,
        outcome         TEXT    NOT NULL,
        response_status INTEGER,
        error           TEXT,
        request_body    TEXT,
        response_body   TEXT,
        duration_ms     INTEGER NOT NULL,
        attempted_at    INTEGER NOT NULL
      ) STRICT;
    `);
    legacy
      .prepare(
        "INSERT INTO delivery_attempts" +
          " (id, task_id, message_id, app_id, endpoint_id, attempt_number, outcome," +
          "  response_status, error, request_body, response_body, duration_ms, attempted_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("datt_legacy", "t_old", "m_old", "app_old", "ep_old", 1, "failed", 502, "old boom", null, null, 7, 1_600_000_000_000);
    legacy.close();

    // Opening the store runs the ALTER migration; the legacy row reads back with a
    // null cause (never classified), and a new attempt can carry one.
    const store = new SqliteDeliveryAttemptStore({ location: dbPath });
    try {
      const legacyPage = await store.listByMessage("m_old");
      expect(legacyPage.data).toHaveLength(1);
      expect(legacyPage.data[0]!.failureReason).toBeNull();
      expect(legacyPage.data[0]!.error).toBe("old boom");

      const recorded = await store.record({
        taskId: "t_new",
        messageId: "m_new",
        attemptNumber: 1,
        outcome: "failed",
        responseStatus: null,
        error: "refused",
        failureReason: "connection_refused",
        durationMs: 0,
        attemptedAt: 1_700_000_000_000,
      });
      expect(recorded.failureReason).toBe("connection_refused");
      expect((await store.listByMessage("m_new")).data[0]!.failureReason).toBe("connection_refused");
    } finally {
      store.close();
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
      expect((await a.listByMessage("m")).data.length).toBe(1);
      expect((await b.listByMessage("m")).data.length).toBe(0);
      expect(b.size).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
