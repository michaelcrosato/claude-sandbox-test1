/**
 * The shared behavioural contract for any {@link EndpointStore} backend.
 *
 * Every backend (in-memory, SQLite, and any future Postgres backend) runs this
 * one suite, so "the durable store behaves exactly like the reference" is a fact
 * the test run proves rather than a comment we hope holds. Backends supply a
 * factory; the suite drives it with an injected deterministic clock, id
 * generator, and secret generator so ids, secrets, and timestamps are
 * reproducible across engines.
 *
 * Not a `*.test.ts` file, so Vitest does not collect it directly — each backend
 * imports {@link describeEndpointStoreContract} and calls it from its own test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeSigningSecrets,
  DEFAULT_SECRET_ROTATION_OVERLAP_MS,
  UnknownEndpointError,
  type EndpointStore,
  type NewEndpoint,
} from "./endpoint.js";

/** Controllable clock + deterministic id/secret generators. */
export interface EndpointConformanceClock {
  advance(ms: number): void;
  now: () => number;
  generateId: () => string;
  generateSecret: () => string;
}

/**
 * Build a fresh clock starting at `startMs` with sequential `ep_test_N` ids and
 * `whsec_test_N` secrets.
 */
export function makeEndpointConformanceClock(
  startMs = 1_700_000_000_000,
): EndpointConformanceClock {
  let nowMs = startMs;
  let idSeq = 0;
  let secretSeq = 0;
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    generateId: () => `ep_test_${++idSeq}`,
    generateSecret: () => `whsec_test_${++secretSeq}`,
  };
}

/** The options every backend factory must honour for conformance. */
export interface ConformanceEndpointStoreOptions {
  now: () => number;
  generateId: () => string;
  generateSecret: () => string;
}

/** Constructs a backend under test from injected determinism options. */
export type EndpointStoreFactory = (
  options: ConformanceEndpointStoreOptions,
) => EndpointStore;

/**
 * Register the full {@link EndpointStore} contract against one backend.
 *
 * @param label     Human-readable backend name, used in the describe block.
 * @param makeStore Factory that builds a fresh store from the given options.
 */
export function describeEndpointStoreContract(
  label: string,
  makeStore: EndpointStoreFactory,
): void {
  describe(`${label} — EndpointStore contract`, () => {
    let clock: EndpointConformanceClock;
    /** Stores built during a test; closed afterwards if they expose close(). */
    const created: EndpointStore[] = [];

    function make(): EndpointStore {
      const store = makeStore({
        now: clock.now,
        generateId: clock.generateId,
        generateSecret: clock.generateSecret,
      });
      created.push(store);
      return store;
    }

    /** A minimal valid create input. */
    const NEW: NewEndpoint = { appId: "app_1", url: "https://example.com/hook" };

    let store: EndpointStore;
    beforeEach(() => {
      clock = makeEndpointConformanceClock();
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
      it("creates an endpoint with id, url, generated secret, defaults, and timestamps", async () => {
        const endpoint = await store.create(NEW);
        expect(endpoint.id).toBe("ep_test_1");
        expect(endpoint.appId).toBe("app_1");
        expect(endpoint.url).toBe("https://example.com/hook");
        expect(endpoint.secret).toBe("whsec_test_1"); // generated
        expect(endpoint.description).toBe("");
        expect(endpoint.eventTypes).toBeNull(); // subscribe-to-all
        expect(endpoint.disabled).toBe(false);
        expect(endpoint.createdAt).toBe(clock.now());
        expect(endpoint.updatedAt).toBe(clock.now());
        expect(await store.get(endpoint.id)).toEqual(endpoint);
      });

      it("uses a supplied secret instead of generating one", async () => {
        const endpoint = await store.create({ ...NEW, secret: "whsec_custom" });
        expect(endpoint.secret).toBe("whsec_custom");
      });

      it("stores description, deduped eventTypes, and disabled when provided", async () => {
        const endpoint = await store.create({
          ...NEW,
          description: "prod hook",
          eventTypes: ["user.created", "user.updated", "user.created"],
          disabled: true,
        });
        expect(endpoint.description).toBe("prod hook");
        expect(endpoint.eventTypes).toEqual(["user.created", "user.updated"]);
        expect(endpoint.disabled).toBe(true);
        expect(await store.get(endpoint.id)).toEqual(endpoint);
      });

      it("normalizes the url (host-case, trailing slash)", async () => {
        const endpoint = await store.create({ ...NEW, url: "https://EXAMPLE.com" });
        expect(endpoint.url).toBe("https://example.com/");
      });

      it("rejects an invalid url, a non-http(s) scheme, and an empty url", async () => {
        await expect(store.create({ ...NEW, url: "not a url" })).rejects.toThrow(
          TypeError,
        );
        await expect(
          store.create({ ...NEW, url: "ftp://example.com" }),
        ).rejects.toThrow(TypeError);
        await expect(store.create({ ...NEW, url: "" })).rejects.toThrow(TypeError);
      });

      it("rejects an empty appId and malformed eventTypes/description/secret", async () => {
        await expect(store.create({ ...NEW, appId: "" })).rejects.toThrow(
          TypeError,
        );
        await expect(
          store.create({ ...NEW, eventTypes: [""] }),
        ).rejects.toThrow(TypeError);
        await expect(
          // @ts-expect-error — eventTypes entries must be strings
          store.create({ ...NEW, eventTypes: [123] }),
        ).rejects.toThrow(TypeError);
        await expect(
          // @ts-expect-error — description must be a string
          store.create({ ...NEW, description: 123 }),
        ).rejects.toThrow(TypeError);
        await expect(store.create({ ...NEW, secret: "" })).rejects.toThrow(
          TypeError,
        );
      });

      it("returns null from get for an unknown id", async () => {
        expect(await store.get("ep_nope")).toBeNull();
      });
    });

    describe("listByApp", () => {
      it("lists a tenant's endpoints oldest-first", async () => {
        const a = await store.create({ ...NEW, secret: "s1" });
        const b = await store.create({ ...NEW, secret: "s2" });
        const c = await store.create({ ...NEW, secret: "s3" });
        const listed = await store.listByApp("app_1");
        expect(listed.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
      });

      it("isolates tenants and returns empty for an unknown app", async () => {
        const mine = await store.create({ appId: "app_1", url: "https://a.test/x" });
        await store.create({ appId: "app_2", url: "https://b.test/y" });
        const listed = await store.listByApp("app_1");
        expect(listed.map((e) => e.id)).toEqual([mine.id]);
        expect(await store.listByApp("app_unknown")).toEqual([]);
      });
    });

    describe("update", () => {
      it("patches provided fields, bumps updatedAt, and preserves the rest", async () => {
        const created0 = await store.create({
          ...NEW,
          description: "before",
          eventTypes: ["a"],
        });
        clock.advance(5_000);
        const updated = await store.update(created0.id, {
          url: "https://example.com/changed",
          disabled: true,
        });
        expect(updated.url).toBe("https://example.com/changed");
        expect(updated.disabled).toBe(true);
        // Unspecified fields are preserved.
        expect(updated.description).toBe("before");
        expect(updated.eventTypes).toEqual(["a"]);
        expect(updated.secret).toBe(created0.secret);
        // Identity + createdAt preserved, updatedAt advanced.
        expect(updated.id).toBe(created0.id);
        expect(updated.appId).toBe(created0.appId);
        expect(updated.createdAt).toBe(created0.createdAt);
        expect(updated.updatedAt).toBe(clock.now());
        expect(await store.get(created0.id)).toEqual(updated);
      });

      it("rotates the secret and replaces the subscription filter (incl. back to all)", async () => {
        const e = await store.create({ ...NEW, eventTypes: ["a"] });
        const rotated = await store.update(e.id, { secret: "whsec_rotated" });
        expect(rotated.secret).toBe("whsec_rotated");
        const narrowed = await store.update(e.id, { eventTypes: ["x", "y"] });
        expect(narrowed.eventTypes).toEqual(["x", "y"]);
        const widened = await store.update(e.id, { eventTypes: null });
        expect(widened.eventTypes).toBeNull();
      });

      it("validates patched fields like create", async () => {
        const e = await store.create(NEW);
        await expect(
          store.update(e.id, { url: "ftp://nope" }),
        ).rejects.toThrow(TypeError);
        await expect(store.update(e.id, { secret: "" })).rejects.toThrow(
          TypeError,
        );
      });

      it("throws UnknownEndpointError for an unknown id", async () => {
        await expect(
          store.update("ep_nope", { disabled: true }),
        ).rejects.toBeInstanceOf(UnknownEndpointError);
      });
    });

    describe("rotateSecret", () => {
      it("installs a fresh primary, retires the old with the default overlap, and persists", async () => {
        const e = await store.create({ ...NEW, description: "prod", eventTypes: ["a"] });
        expect(e.secret).toBe("whsec_test_1");
        expect(e.previousSecrets).toEqual([]);

        clock.advance(5_000);
        const rotated = await store.rotateSecret(e.id);
        const expiresAt = clock.now() + DEFAULT_SECRET_ROTATION_OVERLAP_MS;
        // The new primary is freshly generated; the old one is retained with overlap.
        expect(rotated.secret).toBe("whsec_test_2");
        expect(rotated.previousSecrets).toEqual([
          { secret: "whsec_test_1", expiresAt },
        ]);
        // Identity + unrelated fields are preserved; updatedAt advanced.
        expect(rotated.id).toBe(e.id);
        expect(rotated.description).toBe("prod");
        expect(rotated.eventTypes).toEqual(["a"]);
        expect(rotated.createdAt).toBe(e.createdAt);
        expect(rotated.updatedAt).toBe(clock.now());
        // It survives the round-trip (the durable backends actually wrote it).
        expect(await store.get(e.id)).toEqual(rotated);
      });

      it("signs with both secrets during the overlap, then only the new one", async () => {
        const e = await store.create(NEW); // secret whsec_test_1
        const rotated = await store.rotateSecret(e.id); // primary whsec_test_2
        // During the overlap window, both the new and old secret are active.
        expect(activeSigningSecrets(rotated, clock.now())).toEqual([
          "whsec_test_2",
          "whsec_test_1",
        ]);
        // Past the overlap, only the new primary signs (zero-downtime window closed).
        const reloaded = (await store.get(e.id))!;
        expect(
          activeSigningSecrets(reloaded, clock.now() + DEFAULT_SECRET_ROTATION_OVERLAP_MS + 1),
        ).toEqual(["whsec_test_2"]);
      });

      it("accepts an explicit secret and overlap window (overlapMs 0 = hard swap)", async () => {
        const e = await store.create(NEW);
        const rotated = await store.rotateSecret(e.id, {
          secret: "whsec_chosen",
          overlapMs: 0,
        });
        expect(rotated.secret).toBe("whsec_chosen");
        // overlapMs 0 retains nothing — an instant swap.
        expect(rotated.previousSecrets).toEqual([]);
        expect(await store.get(e.id)).toEqual(rotated);
      });

      it("rejects a malformed secret or a negative overlap (TypeError)", async () => {
        const e = await store.create(NEW);
        await expect(store.rotateSecret(e.id, { secret: "" })).rejects.toThrow(TypeError);
        await expect(
          store.rotateSecret(e.id, { overlapMs: -1 }),
        ).rejects.toThrow(TypeError);
      });

      it("throws UnknownEndpointError for an unknown id", async () => {
        await expect(store.rotateSecret("ep_nope")).rejects.toBeInstanceOf(
          UnknownEndpointError,
        );
      });
    });

    describe("delete", () => {
      it("removes an endpoint and reports whether it existed", async () => {
        const e = await store.create(NEW);
        expect(await store.delete(e.id)).toBe(true);
        expect(await store.get(e.id)).toBeNull();
        // Idempotent: a second delete (and an unknown id) report false.
        expect(await store.delete(e.id)).toBe(false);
        expect(await store.delete("ep_nope")).toBe(false);
      });

      it("only removes the targeted endpoint", async () => {
        const a = await store.create({ ...NEW, secret: "s1" });
        const b = await store.create({ ...NEW, secret: "s2" });
        expect(await store.delete(a.id)).toBe(true);
        expect((await store.listByApp("app_1")).map((e) => e.id)).toEqual([b.id]);
      });
    });
  });
}
