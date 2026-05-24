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
  type EndpointFilter,
  type EndpointStore,
  type NewEndpoint,
} from "./endpoint.js";
import { endpointToDeliveryTarget } from "./endpoint-resolver.js";

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
        // A fresh endpoint starts healthy: no failure streak.
        expect(endpoint.consecutiveFailures).toBe(0);
        expect(endpoint.firstFailureAt).toBeNull();
        expect(endpoint.lastFailureAt).toBeNull();
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

    describe("custom headers", () => {
      it("defaults headers to null when not provided on create", async () => {
        const e = await store.create(NEW);
        expect(e.headers).toBeNull();
        expect((await store.get(e.id))!.headers).toBeNull();
      });

      it("stores custom headers on create and returns them on get", async () => {
        const e = await store.create({
          ...NEW,
          headers: { "X-API-Key": "secret123", "X-Tenant-ID": "t_1" },
        });
        expect(e.headers).toEqual({ "X-API-Key": "secret123", "X-Tenant-ID": "t_1" });
        expect((await store.get(e.id))!.headers).toEqual({
          "X-API-Key": "secret123",
          "X-Tenant-ID": "t_1",
        });
      });

      it("update can set, replace, and clear headers", async () => {
        const e = await store.create({ ...NEW, headers: { "X-Foo": "bar" } });
        // Replace with a different map.
        const replaced = await store.update(e.id, { headers: { "X-Baz": "qux" } });
        expect(replaced.headers).toEqual({ "X-Baz": "qux" });
        // Clear headers (null).
        const cleared = await store.update(e.id, { headers: null });
        expect(cleared.headers).toBeNull();
        expect((await store.get(e.id))!.headers).toBeNull();
      });

      it("update preserves headers when headers is not in the patch", async () => {
        const e = await store.create({ ...NEW, headers: { "X-Keep": "me" } });
        const updated = await store.update(e.id, { description: "changed" });
        expect(updated.headers).toEqual({ "X-Keep": "me" });
      });

      it("custom headers are forwarded to the DeliveryTarget via endpointToDeliveryTarget", async () => {
        const e = await store.create({ ...NEW, headers: { "X-Auth": "tok" } });
        const target = endpointToDeliveryTarget(e, clock.now());
        expect(target.headers).toEqual({ "X-Auth": "tok" });
      });

      it("endpointToDeliveryTarget omits headers field when endpoint has none", async () => {
        const e = await store.create(NEW);
        const target = endpointToDeliveryTarget(e, clock.now());
        expect(target.headers).toBeUndefined();
      });
    });

    describe("retryPolicy", () => {
      it("defaults retryPolicy to null when not provided on create", async () => {
        const e = await store.create(NEW);
        expect(e.retryPolicy).toBeNull();
        expect((await store.get(e.id))!.retryPolicy).toBeNull();
      });

      it("stores a custom retryPolicy on create and returns it on get", async () => {
        const policy = { delaysMs: [1000, 5000, 30000] };
        const e = await store.create({ ...NEW, retryPolicy: policy });
        expect(e.retryPolicy).toEqual(policy);
        expect((await store.get(e.id))!.retryPolicy).toEqual(policy);
      });

      it("update can set, replace, and clear retryPolicy", async () => {
        const policy = { delaysMs: [500, 2000] };
        const e = await store.create({ ...NEW, retryPolicy: policy });
        // Replace with a different schedule.
        const replaced = await store.update(e.id, { retryPolicy: { delaysMs: [100] } });
        expect(replaced.retryPolicy).toEqual({ delaysMs: [100] });
        // Clear retryPolicy (null = use system default).
        const cleared = await store.update(e.id, { retryPolicy: null });
        expect(cleared.retryPolicy).toBeNull();
        expect((await store.get(e.id))!.retryPolicy).toBeNull();
      });

      it("update preserves retryPolicy when retryPolicy is not in the patch", async () => {
        const policy = { delaysMs: [5000] };
        const e = await store.create({ ...NEW, retryPolicy: policy });
        const updated = await store.update(e.id, { description: "changed" });
        expect(updated.retryPolicy).toEqual(policy);
      });

      it("retryPolicy is forwarded to the DeliveryTarget via endpointToDeliveryTarget", async () => {
        const policy = { delaysMs: [1000, 5000] };
        const e = await store.create({ ...NEW, retryPolicy: policy });
        const target = endpointToDeliveryTarget(e, clock.now());
        expect(target.retryPolicy).toEqual(policy);
      });

      it("endpointToDeliveryTarget omits retryPolicy field when endpoint has none", async () => {
        const e = await store.create(NEW);
        const target = endpointToDeliveryTarget(e, clock.now());
        expect(target.retryPolicy).toBeUndefined();
      });

      it("stores nonRetryableStatuses on create and round-trips via get", async () => {
        const policy = { delaysMs: [1000], nonRetryableStatuses: [400, 401, 410] };
        const e = await store.create({ ...NEW, retryPolicy: policy });
        expect(e.retryPolicy).toEqual(policy);
        expect((await store.get(e.id))!.retryPolicy).toEqual(policy);
      });

      it("forwards nonRetryableStatuses to the DeliveryTarget", async () => {
        const policy = { delaysMs: [500], nonRetryableStatuses: [403] };
        const e = await store.create({ ...NEW, retryPolicy: policy });
        const target = endpointToDeliveryTarget(e, clock.now());
        expect(target.retryPolicy).toEqual(policy);
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

    describe("recordDeliveryOutcome (endpoint health + auto-disable)", () => {
      it("is a no-op (returns null endpoint, autoDisabled false) for an unknown/deleted endpoint", async () => {
        const result = await store.recordDeliveryOutcome("ep_nope", "failed", clock.now());
        expect(result.endpoint).toBeNull();
        expect(result.autoDisabled).toBe(false);
      });

      it("a success on a healthy endpoint changes nothing and does not bump updatedAt", async () => {
        const e = await store.create(NEW);
        clock.advance(5_000);
        const after = await store.recordDeliveryOutcome(e.id, "succeeded", clock.now());
        expect(after.endpoint).toEqual(e); // unchanged
        expect(after.autoDisabled).toBe(false);
        // The hot path skips the write: updatedAt is the create time, not now.
        expect((await store.get(e.id))!.updatedAt).toBe(e.updatedAt);
      });

      it("a failure opens the streak, persists count + timestamps, and never disables on its own", async () => {
        const e = await store.create(NEW);
        clock.advance(5_000);
        const t = clock.now();
        const after = await store.recordDeliveryOutcome(e.id, "failed", t);
        expect(after.endpoint!.consecutiveFailures).toBe(1);
        expect(after.endpoint!.firstFailureAt).toBe(t);
        expect(after.endpoint!.lastFailureAt).toBe(t);
        expect(after.endpoint!.disabled).toBe(false);
        expect(after.endpoint!.updatedAt).toBe(t);
        expect(after.autoDisabled).toBe(false);
        expect(await store.get(e.id)).toEqual(after.endpoint); // durably persisted
      });

      it("a success after failures resets the streak (persisted)", async () => {
        const e = await store.create(NEW);
        await store.recordDeliveryOutcome(e.id, "failed", clock.now());
        clock.advance(5_000);
        const recovered = await store.recordDeliveryOutcome(e.id, "succeeded", clock.now());
        expect(recovered.endpoint!.consecutiveFailures).toBe(0);
        expect(recovered.endpoint!.firstFailureAt).toBeNull();
        expect(recovered.endpoint!.lastFailureAt).toBeNull();
        expect(recovered.autoDisabled).toBe(false);
        expect(await store.get(e.id)).toEqual(recovered.endpoint);
      });

      it("auto-disables once failures span the configured window (persisted)", async () => {
        const e = await store.create(NEW);
        const window = 100_000;
        const first = await store.recordDeliveryOutcome(e.id, "failed", clock.now(), window);
        expect(first.endpoint!.disabled).toBe(false);
        expect(first.autoDisabled).toBe(false);
        clock.advance(window);
        const tripped = await store.recordDeliveryOutcome(e.id, "failed", clock.now(), window);
        expect(tripped.autoDisabled).toBe(true);
        expect(tripped.endpoint!.disabled).toBe(true);
        expect(tripped.endpoint!.consecutiveFailures).toBe(2);
        expect((await store.get(e.id))!.disabled).toBe(true);
      });

      it("a window of 0 never auto-disables but still tracks the streak", async () => {
        const e = await store.create(NEW);
        await store.recordDeliveryOutcome(e.id, "failed", clock.now(), 0);
        clock.advance(10 * 24 * 60 * 60 * 1000);
        const after = await store.recordDeliveryOutcome(e.id, "failed", clock.now(), 0);
        expect(after.endpoint!.disabled).toBe(false);
        expect(after.endpoint!.consecutiveFailures).toBe(2);
        expect(after.autoDisabled).toBe(false);
      });

      it("re-enabling an auto-disabled endpoint via update clears the streak", async () => {
        const e = await store.create(NEW);
        const window = 100;
        await store.recordDeliveryOutcome(e.id, "failed", clock.now(), window);
        clock.advance(window);
        const disabled = await store.recordDeliveryOutcome(e.id, "failed", clock.now(), window);
        expect(disabled.endpoint!.disabled).toBe(true);
        const reEnabled = await store.update(e.id, { disabled: false });
        expect(reEnabled.disabled).toBe(false);
        expect(reEnabled.consecutiveFailures).toBe(0);
        expect(reEnabled.firstFailureAt).toBeNull();
        expect(reEnabled.lastFailureAt).toBeNull();
      });
    });

    describe("filter", () => {
      it("defaults filter to null when not provided on create", async () => {
        const e = await store.create(NEW);
        expect(e.filter).toBeNull();
        expect((await store.get(e.id))!.filter).toBeNull();
      });

      it("stores a filter on create and round-trips it via get", async () => {
        const filter: EndpointFilter = {
          op: "and",
          filters: [
            { op: "eq", path: "env", value: "prod" },
            { op: "gt", path: "amount", value: 0 },
          ],
        };
        const e = await store.create({ ...NEW, filter });
        expect(e.filter).toEqual(filter);
        expect((await store.get(e.id))!.filter).toEqual(filter);
      });

      it("update can set, replace, and clear filter", async () => {
        const f1: EndpointFilter = { op: "eq", path: "env", value: "prod" };
        const e = await store.create({ ...NEW, filter: f1 });
        // Replace.
        const f2: EndpointFilter = { op: "eq", path: "env", value: "staging" };
        const replaced = await store.update(e.id, { filter: f2 });
        expect(replaced.filter).toEqual(f2);
        // Clear.
        const cleared = await store.update(e.id, { filter: null });
        expect(cleared.filter).toBeNull();
        expect((await store.get(e.id))!.filter).toBeNull();
      });

      it("update preserves filter when filter is not in the patch", async () => {
        const filter: EndpointFilter = { op: "eq", path: "x", value: 1 };
        const e = await store.create({ ...NEW, filter });
        const updated = await store.update(e.id, { description: "changed" });
        expect(updated.filter).toEqual(filter);
      });
    });

    describe("channel", () => {
      it("defaults channel to null when not provided on create", async () => {
        const e = await store.create(NEW);
        expect(e.channel).toBeNull();
        expect((await store.get(e.id))!.channel).toBeNull();
      });

      it("stores a channel on create and round-trips it via get", async () => {
        const e = await store.create({ ...NEW, channel: "acme" });
        expect(e.channel).toBe("acme");
        expect((await store.get(e.id))!.channel).toBe("acme");
      });

      it("update can set, replace, and clear channel", async () => {
        const e = await store.create({ ...NEW, channel: "acme" });
        // Replace.
        const replaced = await store.update(e.id, { channel: "beta" });
        expect(replaced.channel).toBe("beta");
        // Clear (null = global endpoint).
        const cleared = await store.update(e.id, { channel: null });
        expect(cleared.channel).toBeNull();
        expect((await store.get(e.id))!.channel).toBeNull();
      });

      it("update preserves channel when channel is not in the patch", async () => {
        const e = await store.create({ ...NEW, channel: "acme" });
        const updated = await store.update(e.id, { description: "changed" });
        expect(updated.channel).toBe("acme");
      });

      it("rejects empty, too-long, and control-character channels", async () => {
        await expect(store.create({ ...NEW, channel: "" })).rejects.toThrow(TypeError);
        await expect(store.create({ ...NEW, channel: "a".repeat(201) })).rejects.toThrow(TypeError);
        await expect(store.create({ ...NEW, channel: "bad\nvalue" })).rejects.toThrow(TypeError);
      });
    });

    describe("rateLimit", () => {
      it("defaults rateLimit to null when not provided on create", async () => {
        const e = await store.create(NEW);
        expect(e.rateLimit).toBeNull();
        expect((await store.get(e.id))!.rateLimit).toBeNull();
      });

      it("stores a rateLimit on create and round-trips it via get", async () => {
        const e = await store.create({ ...NEW, rateLimit: 100 });
        expect(e.rateLimit).toBe(100);
        expect((await store.get(e.id))!.rateLimit).toBe(100);
      });

      it("update can set, replace, and clear rateLimit", async () => {
        const e = await store.create({ ...NEW, rateLimit: 50 });
        // Replace.
        const replaced = await store.update(e.id, { rateLimit: 200 });
        expect(replaced.rateLimit).toBe(200);
        // Clear.
        const cleared = await store.update(e.id, { rateLimit: null });
        expect(cleared.rateLimit).toBeNull();
        expect((await store.get(e.id))!.rateLimit).toBeNull();
      });

      it("update preserves rateLimit when rateLimit is not in the patch", async () => {
        const e = await store.create({ ...NEW, rateLimit: 60 });
        const updated = await store.update(e.id, { description: "changed" });
        expect(updated.rateLimit).toBe(60);
      });

      it("rejects out-of-range, non-integer, and wrong-type rateLimits", async () => {
        await expect(store.create({ ...NEW, rateLimit: 0 })).rejects.toThrow(RangeError);
        await expect(store.create({ ...NEW, rateLimit: 10_001 })).rejects.toThrow(RangeError);
        await expect(store.create({ ...NEW, rateLimit: 1.5 as unknown as number })).rejects.toThrow(TypeError);
        await expect(store.create({ ...NEW, rateLimit: "100" as unknown as number })).rejects.toThrow(TypeError);
      });
    });
  });
}
