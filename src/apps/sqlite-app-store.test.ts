import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAppStore } from "./sqlite-app-store.js";
import {
  describeAppStoreContract,
  makeAppConformanceClock,
} from "./conformance.js";

// The SQLite backend must satisfy the exact same contract as the reference
// in-memory store. Conformance runs against an ephemeral `:memory:` database.
describeAppStoreContract("SqliteAppStore", (options) => new SqliteAppStore(options));

describe("SqliteAppStore — specifics", () => {
  it("reports the number of apps held via size", async () => {
    const store = new SqliteAppStore();
    try {
      expect(store.size).toBe(0);
      const a = await store.create({ name: "a" });
      await store.create({ name: "b" });
      expect(store.size).toBe(2);
      await store.delete(a.id);
      expect(store.size).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a duplicate key hash via the UNIQUE constraint", async () => {
    // Force a hash collision by injecting a constant secret generator.
    const store = new SqliteAppStore({ generateApiKeySecret: () => "phk_same" });
    try {
      const app = await store.create();
      await store.createApiKey(app.id);
      await expect(store.createApiKey(app.id)).rejects.toThrow();
    } finally {
      store.close();
    }
  });
});

describe("SqliteAppStore — durability", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posthorn-app-sqlite-"));
    dbPath = join(dir, "apps.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists apps and keys across a reopen, and revocation survives (crash-safe replay)", async () => {
    const clock = makeAppConformanceClock();
    const opts = {
      now: clock.now,
      generateAppId: clock.generateAppId,
      generateApiKeyId: clock.generateApiKeyId,
      generateApiKeySecret: clock.generateApiKeySecret,
    };

    // First process: create an app and two keys, revoke one, then "crash".
    const before = new SqliteAppStore({ location: dbPath, ...opts });
    const app = await before.create({ name: "Acme" });
    const live = await before.createApiKey(app.id); // phk_test_1
    const revoked = await before.createApiKey(app.id); // phk_test_2
    expect(await before.revokeApiKey(revoked.apiKey.id)).toBe(true);
    before.close();

    // Second process: reattach to the same file. The app, the live key, and the
    // revocation all survive intact.
    const after = new SqliteAppStore({ location: dbPath, ...opts });
    try {
      expect(await after.get(app.id)).toEqual(app);
      expect(await after.authenticate(live.secret)).toEqual(app);
      expect(await after.authenticate(revoked.secret)).toBeNull(); // still revoked
      const keys = await after.listApiKeys(app.id);
      expect(keys.map((k) => k.id)).toEqual([live.apiKey.id, revoked.apiKey.id]);
    } finally {
      after.close();
    }
  });

  it("cascade-deletes keys when an app is deleted, surviving a reopen", async () => {
    const before = new SqliteAppStore({ location: dbPath });
    const app = await before.create();
    const { secret } = await before.createApiKey(app.id);
    expect(await before.delete(app.id)).toBe(true);
    before.close();

    const after = new SqliteAppStore({ location: dbPath });
    try {
      expect(await after.get(app.id)).toBeNull();
      expect(await after.authenticate(secret)).toBeNull();
      expect(await after.listApiKeys(app.id)).toEqual([]);
    } finally {
      after.close();
    }
  });

  it("keeps independent stores isolated to their own files", async () => {
    const a = new SqliteAppStore({ location: join(dir, "a.sqlite") });
    const b = new SqliteAppStore({ location: join(dir, "b.sqlite") });
    try {
      const app = await a.create({ name: "a" });
      expect(await a.get(app.id)).not.toBeNull();
      expect(await b.get(app.id)).toBeNull();
      expect(b.size).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
