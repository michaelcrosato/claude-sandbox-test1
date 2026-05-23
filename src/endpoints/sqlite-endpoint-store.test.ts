import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteEndpointStore } from "./sqlite-endpoint-store.js";
import {
  describeEndpointStoreContract,
  makeEndpointConformanceClock,
} from "./conformance.js";

// The SQLite backend must satisfy the exact same contract as the reference
// in-memory store. Conformance runs against an ephemeral `:memory:` database.
describeEndpointStoreContract(
  "SqliteEndpointStore",
  (options) => new SqliteEndpointStore(options),
);

describe("SqliteEndpointStore — specifics", () => {
  it("reports the number of endpoints held via size", async () => {
    const store = new SqliteEndpointStore();
    try {
      expect(store.size).toBe(0);
      const a = await store.create({ appId: "app_1", url: "https://x.test/a" });
      await store.create({ appId: "app_1", url: "https://x.test/b" });
      expect(store.size).toBe(2);
      await store.delete(a.id);
      expect(store.size).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("SqliteEndpointStore — durability", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posthorn-ep-sqlite-"));
    dbPath = join(dir, "endpoints.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists endpoints (with filter + secret) across a reopen (crash-safe replay)", async () => {
    const clock = makeEndpointConformanceClock();
    const opts = {
      now: clock.now,
      generateId: clock.generateId,
      generateSecret: clock.generateSecret,
    };

    // First process: create an endpoint, then "crash".
    const before = new SqliteEndpointStore({ location: dbPath, ...opts });
    const endpoint = await before.create({
      appId: "app_1",
      url: "https://example.com/hook",
      description: "prod",
      eventTypes: ["user.created", "user.updated"],
      disabled: true,
    });
    before.close();

    // Second process: reattach to the same file. The endpoint survives intact,
    // including its JSON-encoded filter and 0/1-encoded disabled flag.
    const after = new SqliteEndpointStore({ location: dbPath, ...opts });
    try {
      expect(after.size).toBe(1);
      expect(await after.get(endpoint.id)).toEqual(endpoint);
      expect((await after.listByApp("app_1")).map((e) => e.id)).toEqual([
        endpoint.id,
      ]);
    } finally {
      after.close();
    }
  });

  it("keeps independent stores isolated to their own files", async () => {
    const a = new SqliteEndpointStore({ location: join(dir, "a.sqlite") });
    const b = new SqliteEndpointStore({ location: join(dir, "b.sqlite") });
    try {
      const endpoint = await a.create({ appId: "app_1", url: "https://x.test/a" });
      expect(await a.get(endpoint.id)).not.toBeNull();
      expect(await b.get(endpoint.id)).toBeNull();
      expect(b.size).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
