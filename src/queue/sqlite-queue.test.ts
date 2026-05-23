import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDeliveryQueue } from "./sqlite-queue.js";
import {
  describeDeliveryQueueContract,
  makeQueueConformanceClock,
} from "./conformance.js";

// The SQLite backend must satisfy the exact same contract as the reference
// in-memory queue. Conformance runs against an ephemeral `:memory:` database.
describeDeliveryQueueContract(
  "SqliteDeliveryQueue",
  (options) => new SqliteDeliveryQueue(options),
);

describe("SqliteDeliveryQueue — specifics", () => {
  it("rejects a non-positive visibility timeout at construction", () => {
    expect(() => new SqliteDeliveryQueue({ visibilityTimeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new SqliteDeliveryQueue({ visibilityTimeoutMs: -1 })).toThrow(
      RangeError,
    );
  });

  it("reports task count via size and never prunes terminal tasks", async () => {
    const clock = makeQueueConformanceClock();
    const queue = new SqliteDeliveryQueue({
      now: clock.now,
      generateId: clock.generateId,
      generateLeaseToken: clock.generateLeaseToken,
    });
    try {
      expect(queue.size).toBe(0);
      await queue.enqueue({ messageId: "a" });
      await queue.enqueue({ messageId: "b" });
      expect(queue.size).toBe(2);

      const [task] = await queue.claimDue({ nowMs: clock.now() });
      await queue.complete(task!.id, task!.leaseToken!); // terminal
      expect(queue.size).toBe(2); // succeeded task is kept, not pruned
    } finally {
      queue.close();
    }
  });
});

describe("SqliteDeliveryQueue — durability", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posthorn-queue-"));
    dbPath = join(dir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replays an in-flight lease after a crash (reopen)", async () => {
    const clock = makeQueueConformanceClock();
    const opts = {
      now: clock.now,
      generateId: clock.generateId,
      generateLeaseToken: clock.generateLeaseToken,
      visibilityTimeoutMs: 5_000,
    };

    // First process: enqueue, claim (now in flight), then "crash".
    const before = new SqliteDeliveryQueue({ location: dbPath, ...opts });
    const enq = await before.enqueue({ messageId: "m1" });
    const [claimed] = await before.claimDue({ nowMs: clock.now() });
    expect(claimed!.status).toBe("delivering");
    const firstToken = claimed!.leaseToken!;
    before.close();

    // Second process: reattach to the same file. The in-flight task survives.
    const after = new SqliteDeliveryQueue({ location: dbPath, ...opts });
    try {
      expect(after.size).toBe(1);
      const survived = await after.get(enq.id);
      expect(survived!.status).toBe("delivering");
      expect(survived!.leaseToken).toBe(firstToken);

      // Until the lease lapses it is not re-claimed (no premature double send).
      expect(await after.claimDue({ nowMs: clock.now() })).toEqual([]);

      // Once it lapses, the in-flight work is replayed under a fresh lease —
      // a crash never silently drops a delivery.
      clock.advance(5_000);
      const [replayed] = await after.claimDue({ nowMs: clock.now() });
      expect(replayed!.id).toBe(enq.id);
      expect(replayed!.attempts).toBe(2);
      expect(replayed!.leaseToken).not.toBe(firstToken);

      // The crashed worker's stale token is rejected; the new holder finishes it.
      await expect(
        after.complete(enq.id, firstToken),
      ).rejects.toThrow();
      const done = await after.complete(replayed!.id, replayed!.leaseToken!);
      expect(done.status).toBe("succeeded");
    } finally {
      after.close();
    }
  });

  it("keeps a terminal task terminal across a reopen", async () => {
    const clock = makeQueueConformanceClock();
    const opts = {
      now: clock.now,
      generateId: clock.generateId,
      generateLeaseToken: clock.generateLeaseToken,
    };

    const before = new SqliteDeliveryQueue({ location: dbPath, ...opts });
    const enq = await before.enqueue({ messageId: "m1" });
    const [claimed] = await before.claimDue({ nowMs: clock.now() });
    await before.complete(claimed!.id, claimed!.leaseToken!);
    before.close();

    const after = new SqliteDeliveryQueue({ location: dbPath, ...opts });
    try {
      const survived = await after.get(enq.id);
      expect(survived!.status).toBe("succeeded");
      // Terminal across restart: never re-delivered.
      expect(await after.claimDue({ nowMs: clock.now() })).toEqual([]);
    } finally {
      after.close();
    }
  });

  it("keeps independent queues isolated to their own files", async () => {
    const a = new SqliteDeliveryQueue({ location: join(dir, "a.sqlite") });
    const b = new SqliteDeliveryQueue({ location: join(dir, "b.sqlite") });
    try {
      const task = await a.enqueue({ messageId: "m" });
      expect(await a.get(task.id)).not.toBeNull();
      expect(await b.get(task.id)).toBeNull();
      expect(b.size).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
