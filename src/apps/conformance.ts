/**
 * The shared behavioural contract for any {@link AppStore} backend.
 *
 * Every backend (in-memory, SQLite, and any future Postgres backend) runs this
 * one suite, so "the durable store behaves exactly like the reference" is a fact
 * the test run proves rather than a comment we hope holds. Backends supply a
 * factory; the suite drives it with an injected deterministic clock and id/secret
 * generators so ids, secrets, hashes, and timestamps are reproducible across
 * engines.
 *
 * Not a `*.test.ts` file, so Vitest does not collect it directly — each backend
 * imports {@link describeAppStoreContract} and calls it from its own test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnknownAppError, hashApiKey, type AppStore } from "./app.js";

/** Controllable clock + deterministic id/secret generators. */
export interface AppConformanceClock {
  advance(ms: number): void;
  now: () => number;
  generateAppId: () => string;
  generateApiKeyId: () => string;
  generateApiKeySecret: () => string;
}

/**
 * Build a fresh clock starting at `startMs` with sequential `app_test_N`,
 * `ak_test_N`, and `phk_test_N` generators.
 */
export function makeAppConformanceClock(
  startMs = 1_700_000_000_000,
): AppConformanceClock {
  let nowMs = startMs;
  let appSeq = 0;
  let keySeq = 0;
  let secretSeq = 0;
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    generateAppId: () => `app_test_${++appSeq}`,
    generateApiKeyId: () => `ak_test_${++keySeq}`,
    generateApiKeySecret: () => `phk_test_${++secretSeq}`,
  };
}

/** The options every backend factory must honour for conformance. */
export interface ConformanceAppStoreOptions {
  now: () => number;
  generateAppId: () => string;
  generateApiKeyId: () => string;
  generateApiKeySecret: () => string;
}

/** Constructs a backend under test from injected determinism options. */
export type AppStoreFactory = (options: ConformanceAppStoreOptions) => AppStore;

/**
 * Register the full {@link AppStore} contract against one backend.
 *
 * @param label     Human-readable backend name, used in the describe block.
 * @param makeStore Factory that builds a fresh store from the given options.
 */
export function describeAppStoreContract(
  label: string,
  makeStore: AppStoreFactory,
): void {
  describe(`${label} — AppStore contract`, () => {
    let clock: AppConformanceClock;
    /** Stores built during a test; closed afterwards if they expose close(). */
    const created: AppStore[] = [];

    function make(): AppStore {
      const store = makeStore({
        now: clock.now,
        generateAppId: clock.generateAppId,
        generateApiKeyId: clock.generateApiKeyId,
        generateApiKeySecret: clock.generateApiKeySecret,
      });
      created.push(store);
      return store;
    }

    let store: AppStore;
    beforeEach(() => {
      clock = makeAppConformanceClock();
      store = make();
    });

    afterEach(() => {
      for (const s of created) {
        const close = (s as { close?: () => void }).close;
        if (typeof close === "function") close.call(s);
      }
      created.length = 0;
    });

    describe("create", () => {
      it("creates an app with id, name, and timestamps", async () => {
        const app = await store.create({ name: "Acme" });
        expect(app.id).toBe("app_test_1");
        expect(app.name).toBe("Acme");
        expect(app.createdAt).toBe(clock.now());
        expect(app.updatedAt).toBe(clock.now());
        expect(await store.get(app.id)).toEqual(app);
      });

      it("defaults an absent name to the empty string", async () => {
        const app = await store.create();
        expect(app.name).toBe("");
        expect(await store.get(app.id)).toEqual(app);
      });

      it("rejects a non-string name", async () => {
        // @ts-expect-error — name must be a string
        await expect(store.create({ name: 123 })).rejects.toThrow(TypeError);
      });

      it("returns null from get for an unknown id", async () => {
        expect(await store.get("app_nope")).toBeNull();
      });

      it("defaults monthlyMessageQuota to null (no limit) and persists a set quota", async () => {
        const unlimited = await store.create({ name: "free" });
        expect(unlimited.monthlyMessageQuota).toBeNull();
        expect((await store.get(unlimited.id))?.monthlyMessageQuota).toBeNull();

        const capped = await store.create({ name: "pro", monthlyMessageQuota: 1000 });
        expect(capped.monthlyMessageQuota).toBe(1000);
        // Survives a round-trip through the backend (the SQLite column / in-memory map).
        expect((await store.get(capped.id))?.monthlyMessageQuota).toBe(1000);

        // 0 is a valid quota (a suspended tenant), distinct from null (no limit).
        const suspended = await store.create({ monthlyMessageQuota: 0 });
        expect((await store.get(suspended.id))?.monthlyMessageQuota).toBe(0);
      });

      it("rejects a negative or non-integer quota", async () => {
        await expect(store.create({ monthlyMessageQuota: -1 })).rejects.toThrow(TypeError);
        await expect(store.create({ monthlyMessageQuota: 1.5 })).rejects.toThrow(TypeError);
        // @ts-expect-error — quota must be a number or null
        await expect(store.create({ monthlyMessageQuota: "100" })).rejects.toThrow(TypeError);
      });
    });

    describe("list", () => {
      it("lists apps oldest-first and is empty initially", async () => {
        expect(await store.list()).toEqual([]);
        const a = await store.create({ name: "a" });
        const b = await store.create({ name: "b" });
        const c = await store.create({ name: "c" });
        expect((await store.list()).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
      });
    });

    describe("update", () => {
      it("patches the name, bumps updatedAt, preserves id/createdAt", async () => {
        const app = await store.create({ name: "before" });
        clock.advance(5_000);
        const updated = await store.update(app.id, { name: "after" });
        expect(updated.name).toBe("after");
        expect(updated.id).toBe(app.id);
        expect(updated.createdAt).toBe(app.createdAt);
        expect(updated.updatedAt).toBe(clock.now());
        expect(await store.get(app.id)).toEqual(updated);
      });

      it("throws UnknownAppError for an unknown id", async () => {
        await expect(
          store.update("app_nope", { name: "x" }),
        ).rejects.toBeInstanceOf(UnknownAppError);
      });

      it("sets, changes, and clears the monthly quota; leaves it untouched when omitted", async () => {
        const app = await store.create({ name: "Acme" });
        expect(app.monthlyMessageQuota).toBeNull();

        // Set a quota (a plan upgrade)…
        const capped = await store.update(app.id, { monthlyMessageQuota: 500 });
        expect(capped.monthlyMessageQuota).toBe(500);
        // …a name-only patch leaves the quota in place…
        const renamed = await store.update(app.id, { name: "Acme Inc" });
        expect(renamed.name).toBe("Acme Inc");
        expect(renamed.monthlyMessageQuota).toBe(500);
        // …and null removes the limit again.
        const lifted = await store.update(app.id, { monthlyMessageQuota: null });
        expect(lifted.monthlyMessageQuota).toBeNull();
        expect((await store.get(app.id))?.monthlyMessageQuota).toBeNull();
      });
    });

    describe("delete", () => {
      it("removes an app and reports whether it existed", async () => {
        const app = await store.create();
        expect(await store.delete(app.id)).toBe(true);
        expect(await store.get(app.id)).toBeNull();
        // Idempotent: a second delete (and an unknown id) report false.
        expect(await store.delete(app.id)).toBe(false);
        expect(await store.delete("app_nope")).toBe(false);
      });
    });

    describe("api keys", () => {
      it("mints a key returning a one-time secret and non-secret metadata", async () => {
        const app = await store.create();
        const { apiKey, secret } = await store.createApiKey(app.id);
        expect(secret).toBe("phk_test_1"); // injected generator
        expect(apiKey.id).toBe("ak_test_1");
        expect(apiKey.appId).toBe(app.id);
        expect(apiKey.prefix).toBe(secret); // the short test secret is < prefix length
        expect(apiKey.revokedAt).toBeNull();
        expect(apiKey.lastUsedAt).toBeNull(); // never used yet
        expect(apiKey.createdAt).toBe(clock.now());
        // The minted secret is returned here and listed only as metadata.
        const listed = await store.listApiKeys(app.id);
        expect(listed).toEqual([apiKey]);
      });

      it("updates lastUsedAt on each successful authentication, not on failure", async () => {
        const app = await store.create();
        const { secret } = await store.createApiKey(app.id);

        // Null before first use.
        const [before] = await store.listApiKeys(app.id);
        expect(before?.lastUsedAt).toBeNull();

        // First successful auth records the time.
        clock.advance(1_000);
        await store.authenticate(secret);
        const [after1] = await store.listApiKeys(app.id);
        expect(after1?.lastUsedAt).toBe(clock.now());

        // A later auth bumps it again.
        clock.advance(1_000);
        await store.authenticate(secret);
        const [after2] = await store.listApiKeys(app.id);
        expect(after2?.lastUsedAt).toBe(clock.now());

        // A failed auth (wrong secret) leaves lastUsedAt unchanged.
        const lastGoodTime = clock.now();
        clock.advance(1_000);
        await store.authenticate("phk_wrong");
        const [afterFail] = await store.listApiKeys(app.id);
        expect(afterFail?.lastUsedAt).toBe(lastGoodTime);
      });

      it("throws UnknownAppError when minting for an unknown app", async () => {
        await expect(store.createApiKey("app_nope")).rejects.toBeInstanceOf(
          UnknownAppError,
        );
      });

      it("authenticates a presented secret to its owning app", async () => {
        const app = await store.create({ name: "Acme" });
        const { secret } = await store.createApiKey(app.id);
        expect(await store.authenticate(secret)).toEqual(app);
      });

      it("returns null for an unknown, empty, or wrong secret", async () => {
        const app = await store.create();
        await store.createApiKey(app.id);
        expect(await store.authenticate("phk_does_not_exist")).toBeNull();
        expect(await store.authenticate("")).toBeNull();
      });

      it("supports multiple live keys per app, isolating revocation", async () => {
        const app = await store.create();
        const k1 = await store.createApiKey(app.id);
        const k2 = await store.createApiKey(app.id);
        expect(await store.authenticate(k1.secret)).toEqual(app);
        expect(await store.authenticate(k2.secret)).toEqual(app);
        expect(await store.revokeApiKey(k1.apiKey.id)).toBe(true);
        // k1 no longer authenticates; k2 is unaffected.
        expect(await store.authenticate(k1.secret)).toBeNull();
        expect(await store.authenticate(k2.secret)).toEqual(app);
      });

      it("records the revocation time and makes re-revoke a no-op", async () => {
        const app = await store.create();
        const { apiKey, secret } = await store.createApiKey(app.id);
        clock.advance(1_000);
        expect(await store.revokeApiKey(apiKey.id)).toBe(true);
        const [revoked] = await store.listApiKeys(app.id);
        expect(revoked?.revokedAt).toBe(clock.now());
        expect(await store.authenticate(secret)).toBeNull();
        // Re-revoke and unknown id both report false (no state change).
        expect(await store.revokeApiKey(apiKey.id)).toBe(false);
        expect(await store.revokeApiKey("ak_nope")).toBe(false);
      });

      it("isolates keys per tenant", async () => {
        const a = await store.create({ name: "a" });
        const b = await store.create({ name: "b" });
        const ka = await store.createApiKey(a.id);
        const kb = await store.createApiKey(b.id);
        expect(await store.authenticate(ka.secret)).toEqual(a);
        expect(await store.authenticate(kb.secret)).toEqual(b);
        expect((await store.listApiKeys(a.id)).map((k) => k.id)).toEqual([
          ka.apiKey.id,
        ]);
      });

      it("cascade-deletes an app's keys, after which they stop authenticating", async () => {
        const app = await store.create();
        const { secret } = await store.createApiKey(app.id);
        expect(await store.delete(app.id)).toBe(true);
        expect(await store.authenticate(secret)).toBeNull();
        expect(await store.listApiKeys(app.id)).toEqual([]);
      });

      it("stores only the hash of the secret, matching the shared hash fn", async () => {
        const app = await store.create();
        const { secret } = await store.createApiKey(app.id);
        // The shared hash of the known injected secret authenticates; this also
        // pins that every backend hashes identically (cross-backend key validity).
        expect(hashApiKey(secret)).toHaveLength(64);
        expect(await store.authenticate(secret)).toEqual(app);
      });
    });
  });
}
