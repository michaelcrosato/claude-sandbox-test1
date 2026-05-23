import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteEndpointStore } from "./sqlite-endpoint-store.js";
import { activeSigningSecrets } from "./endpoint.js";
import {
  describeEndpointStoreContract,
  makeEndpointConformanceClock,
} from "./conformance.js";

// Same builtin-load workaround the store uses (Vite-5 mangles a static specifier).
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

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

  it("persists rotated secrets (new primary + retired overlap) across a reopen", async () => {
    const clock = makeEndpointConformanceClock();
    const opts = {
      now: clock.now,
      generateId: clock.generateId,
      generateSecret: clock.generateSecret,
    };

    const before = new SqliteEndpointStore({ location: dbPath, ...opts });
    const e = await before.create({ appId: "app_1", url: "https://example.com/hook" });
    clock.advance(5_000);
    const rotated = await before.rotateSecret(e.id);
    before.close();

    // Reattach: the new primary and the retired-with-expiry secret both survive.
    const after = new SqliteEndpointStore({ location: dbPath, ...opts });
    try {
      const reloaded = (await after.get(e.id))!;
      expect(reloaded).toEqual(rotated);
      expect(reloaded.previousSecrets).toEqual(rotated.previousSecrets);
      // The overlap is still honoured after the restart.
      expect(activeSigningSecrets(reloaded, clock.now())).toEqual([
        rotated.secret,
        e.secret,
      ]);
    } finally {
      after.close();
    }
  });

  it("migrates a pre-rotation database: existing rows default to [] and can then rotate", async () => {
    // Hand-build a database with the *old* schema (no previous_secrets column) and
    // one row, exactly as a build from before this feature would have left it.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE endpoints (
        id          TEXT    PRIMARY KEY,
        app_id      TEXT    NOT NULL,
        url         TEXT    NOT NULL,
        secret      TEXT    NOT NULL,
        description TEXT    NOT NULL,
        event_types TEXT,
        disabled    INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      ) STRICT;
    `);
    legacy.prepare(
      `INSERT INTO endpoints
         (id, app_id, url, secret, description, event_types, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("ep_legacy", "app_1", "https://legacy.test/h", "whsec_legacy", "", null, 0, 1_000, 1_000);
    legacy.close();

    // Opening with the current store runs the column migration. The existing row
    // reads back with an empty previousSecrets (never re-delivering history), and
    // rotation works against the migrated row.
    const clock = makeEndpointConformanceClock(2_000);
    const store = new SqliteEndpointStore({
      location: dbPath,
      now: clock.now,
      generateId: clock.generateId,
      generateSecret: clock.generateSecret,
    });
    try {
      const migrated = (await store.get("ep_legacy"))!;
      expect(migrated.secret).toBe("whsec_legacy");
      expect(migrated.previousSecrets).toEqual([]);

      const rotated = await store.rotateSecret("ep_legacy", { secret: "whsec_new", overlapMs: 1_000 });
      expect(rotated.secret).toBe("whsec_new");
      expect(rotated.previousSecrets).toEqual([
        { secret: "whsec_legacy", expiresAt: clock.now() + 1_000 },
      ]);
      expect((await store.get("ep_legacy"))!.previousSecrets).toEqual(
        rotated.previousSecrets,
      );
    } finally {
      store.close();
    }
  });

  it("migrates a pre-health database: existing rows backfill to healthy and can then auto-disable", async () => {
    // A rotation-era schema: has previous_secrets but none of the health columns,
    // exactly as a build from before automatic disabling would have left it.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE endpoints (
        id               TEXT    PRIMARY KEY,
        app_id           TEXT    NOT NULL,
        url              TEXT    NOT NULL,
        secret           TEXT    NOT NULL,
        previous_secrets TEXT    NOT NULL DEFAULT '[]',
        description      TEXT    NOT NULL,
        event_types      TEXT,
        disabled         INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      ) STRICT;
    `);
    legacy.prepare(
      `INSERT INTO endpoints
         (id, app_id, url, secret, previous_secrets, description, event_types, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("ep_old", "app_1", "https://old.test/h", "whsec_old", "[]", "", null, 0, 1_000, 1_000);
    legacy.close();

    const clock = makeEndpointConformanceClock(2_000);
    const store = new SqliteEndpointStore({
      location: dbPath,
      now: clock.now,
      generateId: clock.generateId,
      generateSecret: clock.generateSecret,
    });
    try {
      // The existing row backfills to healthy (no behaviour change on upgrade).
      const migrated = (await store.get("ep_old"))!;
      expect(migrated.consecutiveFailures).toBe(0);
      expect(migrated.firstFailureAt).toBeNull();
      expect(migrated.lastFailureAt).toBeNull();
      expect(migrated.disabled).toBe(false);

      // And health tracking works against the migrated row: sustained failure disables.
      const window = 50_000;
      await store.recordDeliveryOutcome("ep_old", "failed", clock.now(), window);
      clock.advance(window);
      const tripped = await store.recordDeliveryOutcome("ep_old", "failed", clock.now(), window);
      expect(tripped.endpoint!.disabled).toBe(true);
      expect((await store.get("ep_old"))!.disabled).toBe(true);
    } finally {
      store.close();
    }
  });
});
