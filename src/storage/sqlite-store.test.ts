import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMessageStore } from "./sqlite-store.js";
import {
  describeMessageStoreContract,
  makeConformanceClock,
} from "./conformance.js";

// The SQLite backend must satisfy the exact same contract as the reference
// in-memory store. Conformance runs against an ephemeral `:memory:` database.
describeMessageStoreContract(
  "SqliteMessageStore",
  (options) => new SqliteMessageStore(options),
);

describe("SqliteMessageStore — specifics", () => {
  it("rejects a non-positive idempotency window at construction", () => {
    expect(() => new SqliteMessageStore({ idempotencyWindowMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new SqliteMessageStore({ idempotencyWindowMs: -1 })).toThrow(
      RangeError,
    );
  });

  it("reports the number of messages held via size", async () => {
    const clock = makeConformanceClock();
    const store = new SqliteMessageStore({
      now: clock.now,
      generateId: clock.generateId,
    });
    try {
      expect(store.size).toBe(0);
      await store.create({ appId: "app_1", eventType: "e", payload: "{}" });
      await store.create({ appId: "app_1", eventType: "e", payload: "{}" });
      expect(store.size).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("SqliteMessageStore — durability", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posthorn-sqlite-"));
    dbPath = join(dir, "store.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists messages and idempotency bindings across a reopen (crash-safe replay)", async () => {
    const clock = makeConformanceClock();
    const opts = { now: clock.now, generateId: clock.generateId };

    // First process: accept a message under an idempotency key, then "crash".
    const before = new SqliteMessageStore({ location: dbPath, ...opts });
    const { message } = await before.create({
      appId: "app_1",
      eventType: "user.created",
      payload: '{"id":1}',
      idempotencyKey: "req-1",
    });
    before.close();

    // Second process: reattach to the same file. The message survives, and a
    // producer's post-restart retry of the same key still dedups (no double send).
    const after = new SqliteMessageStore({ location: dbPath, ...opts });
    try {
      expect(after.size).toBe(1);
      expect(await after.get(message.id)).toEqual(message);
      expect(await after.getByIdempotencyKey("app_1", "req-1")).toEqual(message);

      const retry = await after.create({
        appId: "app_1",
        eventType: "user.created",
        payload: '{"id":1}',
        idempotencyKey: "req-1",
      });
      expect(retry.deduplicated).toBe(true);
      expect(retry.message.id).toBe(message.id);
      expect(after.size).toBe(1); // still no duplicate
    } finally {
      after.close();
    }
  });

  it("keeps independent stores isolated to their own files", async () => {
    const a = new SqliteMessageStore({ location: join(dir, "a.sqlite") });
    const b = new SqliteMessageStore({ location: join(dir, "b.sqlite") });
    try {
      const { message } = await a.create({
        appId: "app_1",
        eventType: "e",
        payload: "{}",
      });
      expect(await a.get(message.id)).not.toBeNull();
      expect(await b.get(message.id)).toBeNull();
      expect(b.size).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
