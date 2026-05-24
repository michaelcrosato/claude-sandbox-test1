import { describe, expect, it, vi } from "vitest";
import { createApi, type ApiHandler, type ApiRequest, type ApiResponse } from "./api.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { InMemoryDeliveryAttemptStore } from "../attempts/in-memory-attempt-store.js";
import { MetricsRegistry } from "../metrics/metrics.js";
import { DeliveryWorker, type HttpDeliveryRequest } from "../worker/delivery-worker.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import { verify } from "../signing/webhook-signature.js";
import { fixedSchedule } from "../delivery/retry-policy.js";
import { InMemoryPortalSessionStore } from "../portal/portal-session.js";
import { InMemoryEventTypeStore } from "../event-types/in-memory-event-type-store.js";

interface Fixture {
  readonly apps: InMemoryAppStore;
  readonly endpoints: InMemoryEndpointStore;
  readonly messages: InMemoryMessageStore;
  readonly queue: InMemoryDeliveryQueue;
  readonly attempts: InMemoryDeliveryAttemptStore;
  readonly api: ApiHandler;
  readonly appId: string;
  readonly secret: string;
}

async function setup(): Promise<Fixture> {
  const apps = new InMemoryAppStore();
  const endpoints = new InMemoryEndpointStore();
  const messages = new InMemoryMessageStore();
  const queue = new InMemoryDeliveryQueue();
  const attempts = new InMemoryDeliveryAttemptStore();
  const eventTypes = new InMemoryEventTypeStore();
  const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes });
  const app = await apps.create({ name: "Acme" });
  const { secret } = await apps.createApiKey(app.id);
  return { apps, endpoints, messages, queue, attempts, api, appId: app.id, secret };
}

/** Build a request, defaulting the unset fields. */
function request(partial: Partial<ApiRequest>): ApiRequest {
  return { method: "GET", path: "/", headers: {}, query: {}, rawBody: "", ...partial };
}

/** Build an authenticated JSON request. */
function jsonRequest(
  method: string,
  path: string,
  body: unknown,
  secret?: string,
): ApiRequest {
  return request({
    method,
    path,
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { authorization: `Bearer ${secret}` } : {}),
    },
    rawBody: JSON.stringify(body),
  });
}

/** Read the JSON body of a response loosely (it is an unserialized value). */
function body(response: ApiResponse): Record<string, any> {
  return response.body as Record<string, any>;
}

describe("createApi — health & routing", () => {
  it("serves an unauthenticated health check", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/healthz" }));
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ status: "ok" });
  });

  it("returns 404 for an unknown route", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/nope" }));
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("serves the OpenAPI document unauthenticated as JSON", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/openapi.json" }));
    expect(res.status).toBe(200);
    // No raw-body opt-out: it is JSON-encoded like every other non-/metrics route.
    expect(res.contentType).toBeUndefined();
    const doc = body(res);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/messages"]).toBeDefined();
    expect(doc.paths["/v1/endpoints/{id}"]).toBeDefined();
  });

  it("returns 405 with an Allow header for a known path, wrong method", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "PUT", path: "/v1/endpoints/ep_1" }));
    expect(res.status).toBe(405);
    expect(body(res).error.code).toBe("method_not_allowed");
    expect(res.headers?.["allow"]).toContain("GET");
  });
});

describe("createApi — authentication", () => {
  it("rejects a missing Authorization header with 401 + WWW-Authenticate", async () => {
    const { api } = await setup();
    const res = await api(jsonRequest("POST", "/v1/messages", { payload: {} }));
    expect(res.status).toBe(401);
    expect(body(res).error.code).toBe("unauthorized");
    expect(res.headers?.["www-authenticate"]).toBe("Bearer");
  });

  it("rejects a non-Bearer scheme with 401", async () => {
    const { api } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: "Basic abc123" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown key with 401", async () => {
    const { api } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: "Bearer phk_not_a_real_key" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a revoked key with 401", async () => {
    const { api, apps, appId } = await setup();
    const { apiKey, secret } = await apps.createApiKey(appId);
    await apps.revokeApiKey(apiKey.id);
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a live key", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("createApi — POST /v1/messages (ingest)", () => {
  it("accepts a message and fans it out to a subscribed endpoint", async () => {
    const { api, secret, queue } = await setup();
    await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://acme.example/hook", eventTypes: ["user.created"] },
        secret,
      ),
    );
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { id: 42 } },
        secret,
      ),
    );
    expect(res.status).toBe(202);
    expect(body(res).deduplicated).toBe(false);
    expect(body(res).fanout.matched).toBe(1);
    expect(body(res).message.id).toMatch(/^msg_/);
    // The fan-out enqueued exactly one delivery task.
    const claimed = await queue.claimDue({ nowMs: Date.now() });
    expect(claimed).toHaveLength(1);
  });

  it("scopes the message to the authenticated tenant, not a body appId", async () => {
    const { api, secret, appId, messages } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { appId: "app_someone_else", eventType: "x", payload: {} },
        secret,
      ),
    );
    const stored = await messages.get(body(res).message.id);
    expect(stored?.appId).toBe(appId);
  });

  it("deduplicates a retried idempotency key and does not re-fan-out", async () => {
    const { api, secret, queue } = await setup();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/h" }, secret),
    );
    const payload = { eventType: "user.created", payload: { id: 1 }, idempotencyKey: "k1" };
    const first = await api(jsonRequest("POST", "/v1/messages", payload, secret));
    const second = await api(jsonRequest("POST", "/v1/messages", payload, secret));
    expect(first.status).toBe(202);
    expect(body(first).deduplicated).toBe(false);
    expect(body(second).deduplicated).toBe(true);
    expect(body(second).fanout).toBeNull();
    expect(body(second).message.id).toBe(body(first).message.id);
    // Only the first create fanned out -> exactly one task.
    const claimed = await queue.claimDue({ nowMs: Date.now() });
    expect(claimed).toHaveLength(1);
  });

  it("returns 409 on an idempotency-key conflict", async () => {
    const { api, secret } = await setup();
    await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "a", payload: { v: 1 }, idempotencyKey: "k" },
        secret,
      ),
    );
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "a", payload: { v: 2 }, idempotencyKey: "k" },
        secret,
      ),
    );
    expect(res.status).toBe(409);
    expect(body(res).error.code).toBe("idempotency_conflict");
  });

  it("rejects a missing payload with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "a" }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("rejects a missing eventType with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/messages", { payload: {} }, secret),
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400 invalid_json", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/messages",
        headers: { authorization: `Bearer ${secret}` },
        rawBody: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_json");
  });

  it("rejects an empty body with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/messages",
        headers: { authorization: `Bearer ${secret}` },
        rawBody: "",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-object JSON body with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/messages",
        headers: { authorization: `Bearer ${secret}` },
        rawBody: "[1,2,3]",
      }),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("delays delivery when sendAt is in the future", async () => {
    let nowMs = 1_700_000_000_000;
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue({ now: () => nowMs });
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes, now: () => nowMs });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://recv.test/h" }, secret));

    const futureMs = nowMs + 10_000;
    const sendAt = new Date(futureMs).toISOString();
    const res = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, sendAt }, secret),
    );
    expect(res.status).toBe(202);
    expect(body(res).fanout.matched).toBe(1);

    // Nothing claimable yet — the task is gated behind sendAt.
    expect(await queue.claimDue({ nowMs })).toHaveLength(0);

    // Advance past sendAt → task becomes claimable.
    nowMs = futureMs + 1;
    expect(await queue.claimDue({ nowMs })).toHaveLength(1);
  });

  it("rejects a non-string sendAt with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, sendAt: 12345 }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("rejects an invalid sendAt string with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, sendAt: "not-a-date" }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("treats a null sendAt as immediate delivery", async () => {
    const { api, secret, queue } = await setup();
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://recv.test/h" }, secret));
    const res = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, sendAt: null }, secret),
    );
    expect(res.status).toBe(202);
    expect(await queue.claimDue({ nowMs: Date.now() })).toHaveLength(1);
  });

  it("stores deliverAt and returns it in the response", async () => {
    let nowMs = 1_700_000_000_000;
    const apps = new InMemoryAppStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue({ now: () => nowMs });
    const endpoints = new InMemoryEndpointStore();
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes, now: () => nowMs });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);

    const futureMs = nowMs + 30_000;
    const sendAt = new Date(futureMs).toISOString();
    const createRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, sendAt }, secret),
    );
    expect(createRes.status).toBe(202);
    // deliverAt should be the epoch-ms equivalent of sendAt.
    expect(body(createRes).message.deliverAt).toBe(futureMs);
    // deliverAt: null for a message created without sendAt.
    const nowRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    expect(body(nowRes).message.deliverAt).toBeNull();
  });

  it("stores expiresAt and returns it in the response", async () => {
    let nowMs = 1_700_000_000_000;
    const apps = new InMemoryAppStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue({ now: () => nowMs });
    const endpoints = new InMemoryEndpointStore();
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes, now: () => nowMs });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);

    const futureMs = nowMs + 300_000;
    const expiresAt = new Date(futureMs).toISOString();
    const createRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, expiresAt }, secret),
    );
    expect(createRes.status).toBe(202);
    expect(body(createRes).message.expiresAt).toBe(futureMs);
    // expiresAt: null for a message created without expiresAt.
    const nowRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    expect(body(nowRes).message.expiresAt).toBeNull();
  });

  it("stores priority and returns it in the response", async () => {
    let nowMs = 1_700_000_000_000;
    const apps = new InMemoryAppStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue({ now: () => nowMs });
    const endpoints = new InMemoryEndpointStore();
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes, now: () => nowMs });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);

    const highRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, priority: "high" }, secret),
    );
    expect(highRes.status).toBe(202);
    expect(body(highRes).message.priority).toBe("high");

    const lowRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {}, priority: "low" }, secret),
    );
    expect(body(lowRes).message.priority).toBe("low");

    // Default: normal when priority omitted.
    const defaultRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    expect(body(defaultRes).message.priority).toBe("normal");
  });
});

describe("createApi — POST /v1/messages monthly quota enforcement", () => {
  interface QuotaFixture {
    readonly api: ApiHandler;
    readonly secret: string;
    setNow(ms: number): void;
  }

  /**
   * An API for a single tenant with the given monthly quota, over a clock shared by
   * the message store (so messages land in the window) and the quota check itself
   * (so `utcMonthRange(now)` lines up). The clock can be advanced across a month edge.
   */
  async function setupQuota(quota: number | null): Promise<QuotaFixture> {
    let nowMs = Date.UTC(2026, 4, 15, 12, 0, 0); // 2026-05-15T12:00:00Z
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, now: () => nowMs, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Acme", monthlyMessageQuota: quota });
    const { secret } = await apps.createApiKey(app.id);
    return { api, secret, setNow: (ms) => { nowMs = ms; } };
  }

  /** Send one message; an optional idempotency key drives the replay path. */
  function send(api: ApiHandler, secret: string, idempotencyKey?: string): Promise<ApiResponse> {
    return api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "e", payload: {}, ...(idempotencyKey ? { idempotencyKey } : {}) },
        secret,
      ),
    );
  }

  it("never blocks an unlimited (null-quota) tenant", async () => {
    const { api, secret } = await setupQuota(null);
    for (let i = 0; i < 5; i++) {
      expect((await send(api, secret)).status).toBe(202);
    }
  });

  it("admits exactly `quota` messages this month, then 429s the next", async () => {
    const { api, secret } = await setupQuota(2);
    expect((await send(api, secret)).status).toBe(202);
    expect((await send(api, secret)).status).toBe(202);
    const blocked = await send(api, secret);
    expect(blocked.status).toBe(429);
    expect(body(blocked).error.code).toBe("quota_exceeded");
  });

  it("blocks every send for a quota of 0 (a suspended tenant)", async () => {
    const { api, secret } = await setupQuota(0);
    const res = await send(api, secret);
    expect(res.status).toBe(429);
    expect(body(res).error.code).toBe("quota_exceeded");
  });

  it("exempts an idempotent replay even once the ceiling is reached", async () => {
    const { api, secret } = await setupQuota(1);
    // Spend the single message of the month under a key.
    expect((await send(api, secret, "k1")).status).toBe(202);
    // A brand-new message is now blocked…
    expect((await send(api, secret, "k2")).status).toBe(429);
    // …but replaying the already-accepted key creates no new message, so it is allowed
    // (failing it would break idempotency for a client retrying a send it already made).
    const replay = await send(api, secret, "k1");
    expect(replay.status).toBe(202);
    expect(body(replay).deduplicated).toBe(true);
  });

  it("resets the allowance at the UTC month boundary (no scheduled job)", async () => {
    const { api, secret, setNow } = await setupQuota(1);
    expect((await send(api, secret)).status).toBe(202); // May allowance spent
    expect((await send(api, secret)).status).toBe(429);
    // Crossing into June moves the window; the new month starts fresh.
    setNow(Date.UTC(2026, 5, 1, 0, 0, 0)); // 2026-06-01T00:00:00Z
    expect((await send(api, secret)).status).toBe(202);
  });
});

describe("createApi — GET /v1/usage (tenant self-service)", () => {
  interface UsageFixture {
    readonly api: ApiHandler;
    readonly secret: string;
    readonly appId: string;
    readonly messages: InMemoryMessageStore;
    readonly attempts: InMemoryDeliveryAttemptStore;
    setNow(ms: number): void;
  }

  /**
   * A single-tenant API over a clock shared by the message store (so messages land
   * on the intended UTC day) and the usage route (so the current-month window lines
   * up). The clock can be moved to seed messages in different months.
   */
  async function setupUsage(quota: number | null = null): Promise<UsageFixture> {
    let nowMs = Date.UTC(2026, 4, 15, 12, 0, 0); // 2026-05-15T12:00:00Z
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, now: () => nowMs, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Acme", monthlyMessageQuota: quota });
    const { secret } = await apps.createApiKey(app.id);
    return { api, secret, appId: app.id, messages, attempts, setNow: (ms) => { nowMs = ms; } };
  }

  function usageRequest(secret: string | null, query: Record<string, string> = {}): ApiRequest {
    return request({
      method: "GET",
      path: "/v1/usage",
      query,
      headers: secret !== null ? { authorization: `Bearer ${secret}` } : {},
    });
  }

  it("requires authentication", async () => {
    const { api } = await setupUsage();
    expect((await api(usageRequest(null))).status).toBe(401);
  });

  it("defaults to the current UTC month and reports an unlimited quota as null", async () => {
    const { api, secret, appId, messages } = await setupUsage(null);
    await messages.create({ appId, eventType: "e", payload: "{}" });
    await messages.create({ appId, eventType: "e", payload: "{}" });
    const res = await api(usageRequest(secret));
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      appId,
      from: "2026-05-01",
      to: "2026-05-31",
      total: 2,
      daily: [{ date: "2026-05-15", messages: 2 }],
      // No delivery attempts recorded → an all-zero operations block.
      deliveries: { total: 0, succeeded: 0, failed: 0, daily: [] },
      quota: {
        monthlyMessageQuota: null,
        used: 2,
        remaining: null,
        periodStart: "2026-05-01",
        resetsAt: "2026-06-01",
      },
    });
  });

  it("reports the tenant's delivery-attempt (operations) usage, scoped to the tenant", async () => {
    const { api, secret, appId, attempts } = await setupUsage(null);
    const at = Date.UTC(2026, 4, 15, 13, 0, 0); // 2026-05-15, the current month
    // Two succeeded + one failed attempt for this tenant…
    await attempts.record({ taskId: "t1", messageId: "m1", appId, attemptNumber: 1, outcome: "succeeded", durationMs: 5, attemptedAt: at });
    await attempts.record({ taskId: "t2", messageId: "m2", appId, attemptNumber: 1, outcome: "succeeded", durationMs: 5, attemptedAt: at + 1 });
    await attempts.record({ taskId: "t3", messageId: "m3", appId, attemptNumber: 2, outcome: "failed", responseStatus: 503, error: "x", durationMs: 5, attemptedAt: at + 2 });
    // …and one for a different tenant, which must not leak in.
    await attempts.record({ taskId: "t4", messageId: "m4", appId: "other_app", attemptNumber: 1, outcome: "succeeded", durationMs: 5, attemptedAt: at + 3 });

    const b = body(await api(usageRequest(secret)));
    expect(b.deliveries).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
      daily: [{ date: "2026-05-15", attempts: 3, succeeded: 2, failed: 1 }],
    });
  });

  it("reports used and remaining against a configured quota", async () => {
    const { api, secret, appId, messages } = await setupUsage(10);
    for (let i = 0; i < 3; i++) {
      await messages.create({ appId, eventType: "e", payload: "{}" });
    }
    const b = body(await api(usageRequest(secret)));
    expect(b.quota.monthlyMessageQuota).toBe(10);
    expect(b.quota.used).toBe(3);
    expect(b.quota.remaining).toBe(7);
  });

  it("pulls a historical range while the quota block still reports the current month", async () => {
    const { api, secret, appId, messages, setNow } = await setupUsage(100);
    // One message in April…
    setNow(Date.UTC(2026, 3, 20, 9, 0, 0)); // 2026-04-20
    await messages.create({ appId, eventType: "e", payload: "{}" });
    // …two in May, the "current" month per the clock.
    setNow(Date.UTC(2026, 4, 15, 12, 0, 0)); // 2026-05-15
    await messages.create({ appId, eventType: "e", payload: "{}" });
    await messages.create({ appId, eventType: "e", payload: "{}" });

    const b = body(await api(usageRequest(secret, { from: "2026-04-01", to: "2026-04-30" })));
    // The breakdown is the requested April window…
    expect(b.from).toBe("2026-04-01");
    expect(b.to).toBe("2026-04-30");
    expect(b.total).toBe(1);
    expect(b.daily).toEqual([{ date: "2026-04-20", messages: 1 }]);
    // …but the quota block reflects the current (May) month, not the queried range.
    expect(b.quota.used).toBe(2);
    expect(b.quota.remaining).toBe(98);
    expect(b.quota.periodStart).toBe("2026-05-01");
    expect(b.quota.resetsAt).toBe("2026-06-01");
  });

  it("400s on a partial or invalid range", async () => {
    const { api, secret } = await setupUsage();
    expect((await api(usageRequest(secret, { from: "2026-05-01" }))).status).toBe(400); // missing to
    expect((await api(usageRequest(secret, { to: "2026-05-01" }))).status).toBe(400); // missing from
    expect((await api(usageRequest(secret, { from: "2026-02-30", to: "2026-03-01" }))).status).toBe(400); // invalid day
    expect((await api(usageRequest(secret, { from: "2026-05-02", to: "2026-05-01" }))).status).toBe(400); // inverted
  });

  it("never counts another tenant's messages", async () => {
    const { api, secret, appId, messages } = await setupUsage(null);
    await messages.create({ appId, eventType: "e", payload: "{}" });
    await messages.create({ appId: "app_other", eventType: "e", payload: "{}" });
    const b = body(await api(usageRequest(secret)));
    expect(b.total).toBe(1);
    expect(b.quota.used).toBe(1);
  });
});

describe("createApi — endpoints CRUD", () => {
  it("creates an endpoint, returning the secret exactly once", async () => {
    const { api, secret, appId } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://acme.example/hook", description: "prod" },
        secret,
      ),
    );
    expect(res.status).toBe(201);
    expect(body(res).id).toMatch(/^ep_/);
    expect(body(res).appId).toBe(appId);
    expect(typeof body(res).secret).toBe("string");
    expect(body(res).secret.length).toBeGreaterThan(0);
  });

  it("forces the endpoint's appId to the authenticated tenant", async () => {
    const { api, secret, appId } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { appId: "app_evil", url: "https://acme.example/hook" },
        secret,
      ),
    );
    expect(body(res).appId).toBe(appId);
  });

  it("exposes endpoint health in the view (starts healthy)", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/h" }, secret),
    );
    const b = body(created);
    expect(b.consecutiveFailures).toBe(0);
    expect(b.firstFailureAt).toBeNull();
    expect(b.lastFailureAt).toBeNull();
  });

  it("rejects a non-http(s) URL with 400", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "ftp://x/y" }, secret),
    );
    expect(res.status).toBe(400);
  });

  it("lists only the tenant's endpoints and never leaks the secret", async () => {
    const { api, secret } = await setup();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).data).toHaveLength(1);
    expect(body(res).data[0]).not.toHaveProperty("secret");
  });

  it("gets a single endpoint without its secret", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).id).toBe(id);
    expect(body(res)).not.toHaveProperty("secret");
  });

  it("returns 404 for a missing endpoint id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints/ep_missing",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("updates an endpoint (disable)", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    const res = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { disabled: true }, secret),
    );
    expect(res.status).toBe(200);
    expect(body(res).disabled).toBe(true);
    expect(body(res)).not.toHaveProperty("secret");
  });

  it("deletes an endpoint with 204 and an empty body", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    const res = await api(
      request({
        method: "DELETE",
        path: `/v1/endpoints/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    // It is gone.
    const after = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(after.status).toBe(404);
  });

  it("creates an endpoint with custom headers and returns them in the view", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://a.example/hook", headers: { "X-API-Key": "tok", "X-Tenant": "t1" } },
        secret,
      ),
    );
    expect(res.status).toBe(201);
    expect(body(res).headers).toEqual({ "X-API-Key": "tok", "X-Tenant": "t1" });
  });

  it("updates custom headers on an existing endpoint (set, replace, clear)", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    // Set.
    const set = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { headers: { "X-Foo": "bar" } }, secret),
    );
    expect(body(set).headers).toEqual({ "X-Foo": "bar" });
    // Replace.
    const replaced = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { headers: { "X-Baz": "qux" } }, secret),
    );
    expect(body(replaced).headers).toEqual({ "X-Baz": "qux" });
    // Clear.
    const cleared = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { headers: null }, secret),
    );
    expect(body(cleared).headers).toBeNull();
  });

  it("rejects reserved header names (400) on create and update", async () => {
    const { api, secret } = await setup();
    const bad = await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://a.example/hook", headers: { "webhook-id": "x" } },
        secret,
      ),
    );
    expect(bad.status).toBe(400);
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    const badPatch = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { headers: { "content-type": "text/plain" } }, secret),
    );
    expect(badPatch.status).toBe(400);
  });

  it("endpoint view includes headers: null when no custom headers are set", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    expect(body(created).headers).toBeNull();
  });

  it("creates an endpoint with a custom retryPolicy and returns it in the view", async () => {
    const { api, secret } = await setup();
    const policy = { delaysMs: [1000, 5000, 30000] };
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://a.example/hook", retryPolicy: policy },
        secret,
      ),
    );
    expect(res.status).toBe(201);
    expect(body(res).retryPolicy).toEqual(policy);
  });

  it("updates retryPolicy on an existing endpoint (set, clear)", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    expect(body(created).retryPolicy).toBeNull();
    // Set a custom policy.
    const set = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { retryPolicy: { delaysMs: [500, 2000] } }, secret),
    );
    expect(body(set).retryPolicy).toEqual({ delaysMs: [500, 2000] });
    // Revert to system default (null).
    const cleared = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { retryPolicy: null }, secret),
    );
    expect(body(cleared).retryPolicy).toBeNull();
  });

  it("rejects an invalid retryPolicy (too many delays) with 400", async () => {
    const { api, secret } = await setup();
    const tooMany = Array(25).fill(1000);
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://a.example/hook", retryPolicy: { delaysMs: tooMany } },
        secret,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("creates an endpoint with nonRetryableStatuses and round-trips it in the view", async () => {
    const { api, secret } = await setup();
    const policy = { delaysMs: [1000, 5000], nonRetryableStatuses: [400, 401, 410] };
    const res = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook", retryPolicy: policy }, secret),
    );
    expect(res.status).toBe(201);
    expect(body(res).retryPolicy).toEqual(policy);
  });

  it("updates nonRetryableStatuses via PATCH and clears them by setting null policy", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/1" }, secret),
    );
    const id = body(created).id;
    // Set policy with nonRetryableStatuses.
    const set = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { retryPolicy: { delaysMs: [500], nonRetryableStatuses: [403] } }, secret),
    );
    expect(body(set).retryPolicy).toEqual({ delaysMs: [500], nonRetryableStatuses: [403] });
    // Clear policy entirely.
    const cleared = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { retryPolicy: null }, secret),
    );
    expect(body(cleared).retryPolicy).toBeNull();
  });

  it("creates an endpoint with a payload filter and round-trips it", async () => {
    const { api, secret } = await setup();
    const filter = { op: "eq", path: "env", value: "prod" };
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.test/h", filter }, secret),
    );
    expect(created.status).toBe(201);
    expect(body(created).filter).toEqual(filter);
    const id: string = body(created).id as string;
    const fetched = await api(
      jsonRequest("GET", `/v1/endpoints/${id}`, {}, secret),
    );
    expect(body(fetched).filter).toEqual(filter);
  });

  it("updates and clears a payload filter via PATCH", async () => {
    const { api, secret } = await setup();
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.test/h" }, secret),
    );
    const id: string = body(created).id as string;
    expect(body(created).filter).toBeNull();

    const filter = { op: "and", filters: [{ op: "eq", path: "x", value: 1 }] };
    const updated = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { filter }, secret),
    );
    expect(body(updated).filter).toEqual(filter);

    const cleared = await api(
      jsonRequest("PATCH", `/v1/endpoints/${id}`, { filter: null }, secret),
    );
    expect(body(cleared).filter).toBeNull();
  });

  it("fan-out skippedFiltered count appears in send response", async () => {
    const { api, secret } = await setup();
    // Endpoint subscribed to user.created but only wants env=prod payloads.
    await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://a.test/h", filter: { op: "eq", path: "env", value: "prod" } },
        secret,
      ),
    );
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { env: "staging" } },
        secret,
      ),
    );
    expect(res.status).toBe(202);
    expect(body(res).fanout.matched).toBe(0);
    expect(body(res).fanout.skippedFiltered).toBe(1);
  });
});

describe("createApi — POST /v1/endpoints/:id/rotate-secret", () => {
  /** Create an endpoint via the API and return its id + one-time secret. */
  async function createEndpoint(
    api: ApiHandler,
    secret: string,
  ): Promise<{ id: string; secret: string }> {
    const res = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook" }, secret),
    );
    return { id: body(res).id, secret: body(res).secret };
  }

  it("rotates to a fresh secret, returned exactly once, and never leaks previousSecrets", async () => {
    const { api, secret } = await setup();
    const ep = await createEndpoint(api, secret);

    const res = await api(
      jsonRequest("POST", `/v1/endpoints/${ep.id}/rotate-secret`, {}, secret),
    );
    expect(res.status).toBe(200);
    // A new primary secret is revealed once, and it is different from the original.
    expect(typeof body(res).secret).toBe("string");
    expect(body(res).secret).not.toBe(ep.secret);
    // The retired-secret machinery is never exposed over HTTP.
    expect(body(res)).not.toHaveProperty("previousSecrets");

    // A subsequent GET still omits both the secret and the retired secrets.
    const got = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${ep.id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(got.body).not.toHaveProperty("secret");
    expect(got.body).not.toHaveProperty("previousSecrets");
  });

  it("accepts an empty body (auto-generates the new secret)", async () => {
    const { api, secret } = await setup();
    const ep = await createEndpoint(api, secret);
    // No body at all — the common case.
    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${ep.id}/rotate-secret`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).secret).not.toBe(ep.secret);
  });

  it("honors an explicit secret in the body", async () => {
    const { api, secret } = await setup();
    const ep = await createEndpoint(api, secret);
    const res = await api(
      jsonRequest(
        "POST",
        `/v1/endpoints/${ep.id}/rotate-secret`,
        { secret: "whsec_chosen" },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    expect(body(res).secret).toBe("whsec_chosen");
  });

  it("rejects a malformed secret or a negative overlap with 400", async () => {
    const { api, secret } = await setup();
    const ep = await createEndpoint(api, secret);
    const badSecret = await api(
      jsonRequest("POST", `/v1/endpoints/${ep.id}/rotate-secret`, { secret: "" }, secret),
    );
    const badOverlap = await api(
      jsonRequest("POST", `/v1/endpoints/${ep.id}/rotate-secret`, { overlapMs: -1 }, secret),
    );
    expect(badSecret.status).toBe(400);
    expect(badOverlap.status).toBe(400);
  });

  it("returns 404 for a missing endpoint and requires auth", async () => {
    const { api, secret } = await setup();
    const missing = await api(
      jsonRequest("POST", "/v1/endpoints/ep_missing/rotate-secret", {}, secret),
    );
    expect(missing.status).toBe(404);
    const unauth = await api(
      jsonRequest("POST", "/v1/endpoints/ep_x/rotate-secret", {}),
    );
    expect(unauth.status).toBe(401);
  });
});

describe("createApi — tenant isolation", () => {
  it("hides another tenant's endpoint behind 404 for get/patch/delete and list", async () => {
    const { api, apps } = await setup();
    // Two tenants, each with their own key.
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;

    const bEndpoint = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://b.example/h" }, bKey),
    );
    const bId = body(bEndpoint).id;

    // A cannot see B's endpoint in its own list...
    const aList = await api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: `Bearer ${aKey}` },
      }),
    );
    expect(body(aList).data).toHaveLength(0);

    // ...nor get / patch / delete it (404, not 403 — existence is not revealed).
    const aGet = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${bId}`,
        headers: { authorization: `Bearer ${aKey}` },
      }),
    );
    const aPatch = await api(
      jsonRequest("PATCH", `/v1/endpoints/${bId}`, { disabled: true }, aKey),
    );
    const aDelete = await api(
      request({
        method: "DELETE",
        path: `/v1/endpoints/${bId}`,
        headers: { authorization: `Bearer ${aKey}` },
      }),
    );
    const aRotate = await api(
      jsonRequest("POST", `/v1/endpoints/${bId}/rotate-secret`, {}, aKey),
    );
    expect(aGet.status).toBe(404);
    expect(aPatch.status).toBe(404);
    expect(aDelete.status).toBe(404);
    expect(aRotate.status).toBe(404);

    // B's endpoint is untouched.
    const bGet = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${bId}`,
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(bGet.status).toBe(200);
    expect(body(bGet).disabled).toBe(false);
  });
});

describe("createApi — GET /v1/messages/:id (delivery status)", () => {
  it("rejects an unauthenticated read with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/messages/msg_1" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown message id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/messages/msg_missing",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("returns the message, its payload, and a pending delivery before the worker runs", async () => {
    const { api, secret } = await setup();
    await api(
      jsonRequest(
        "POST",
        "/v1/endpoints",
        { url: "https://acme.example/hook", eventTypes: ["user.created"] },
        secret,
      ),
    );
    const ingest = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { id: 42 } },
        secret,
      ),
    );
    const id = body(ingest).message.id;

    const res = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).id).toBe(id);
    expect(body(res).eventType).toBe("user.created");
    expect(body(res).payload).toBe(JSON.stringify({ id: 42 }));
    expect(body(res).deliveries).toHaveLength(1);
    const delivery = body(res).deliveries[0];
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(0);
    expect(delivery).toHaveProperty("endpointId");
    // Internal queue plumbing is never exposed.
    expect(delivery).not.toHaveProperty("leaseToken");
  });

  it("reflects a succeeded delivery after the worker drains it", async () => {
    const { api, secret, endpoints, messages, queue } = await setup();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const ingest = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { ok: true } },
        secret,
      ),
    );
    const id = body(ingest).message.id;

    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: 200 }),
    });
    const tick = await worker.processOnce();
    expect(tick.succeeded).toBe(1);

    const res = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).deliveries).toHaveLength(1);
    expect(body(res).deliveries[0].status).toBe("succeeded");
    expect(body(res).deliveries[0].attempts).toBe(1);
  });

  it("returns an empty deliveries array when nothing matched fan-out", async () => {
    const { api, secret } = await setup();
    // No endpoints registered → the message is accepted but fans out to nobody.
    const ingest = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: {} },
        secret,
      ),
    );
    expect(body(ingest).fanout.matched).toBe(0);
    const id = body(ingest).message.id;

    const res = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).deliveries).toEqual([]);
  });

  it("hides another tenant's message behind 404", async () => {
    const { api, apps } = await setup();
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;

    const ingest = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, bKey),
    );
    const bMessageId = body(ingest).message.id;

    // A cannot read B's message — 404, not 403 (existence is not revealed).
    const aRead = await api(
      request({
        method: "GET",
        path: `/v1/messages/${bMessageId}`,
        headers: { authorization: `Bearer ${aKey}` },
      }),
    );
    expect(aRead.status).toBe(404);

    // B can read its own.
    const bRead = await api(
      request({
        method: "GET",
        path: `/v1/messages/${bMessageId}`,
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(bRead.status).toBe(200);
    expect(body(bRead).id).toBe(bMessageId);
  });
});

describe("createApi — GET /v1/messages/:id/attempts (audit log)", () => {
  it("rejects an unauthenticated read with 401", async () => {
    const { api } = await setup();
    const res = await api(
      request({ method: "GET", path: "/v1/messages/msg_1/attempts" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown message id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/messages/msg_missing/attempts",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("is an empty list before any attempt has run", async () => {
    const { api, secret } = await setup();
    const ingest = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    const id = body(ingest).message.id;
    const res = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}/attempts`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual([]);
  });

  it("lists a succeeded attempt after the worker delivers", async () => {
    const { api, secret, endpoints, messages, queue, attempts } = await setup();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const ingest = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { ok: true } },
        secret,
      ),
    );
    const id = body(ingest).message.id;

    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: 200 }),
      recordAttempt: async (a) => {
        await attempts.record(a);
      },
    });
    expect((await worker.processOnce()).succeeded).toBe(1);

    const res = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}/attempts`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).data).toHaveLength(1);
    const attempt = body(res).data[0];
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      outcome: "succeeded",
      responseStatus: 200,
      error: null,
    });
    expect(attempt).toHaveProperty("taskId");
    expect(attempt).toHaveProperty("durationMs");
    expect(attempt).toHaveProperty("attemptedAt");
  });

  it("records a failed attempt with its HTTP status and error", async () => {
    const { api, secret, endpoints, messages, queue, attempts } = await setup();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const ingest = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    const id = body(ingest).message.id;

    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: 503 }),
      recordAttempt: async (a) => {
        await attempts.record(a);
      },
    });
    await worker.processOnce(); // one failed attempt (then auto-retry is scheduled)

    const res = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}/attempts`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(body(res).data).toHaveLength(1);
    expect(body(res).data[0]).toMatchObject({ outcome: "failed", responseStatus: 503 });
    expect(body(res).data[0].error).toContain("HTTP 503");
  });

  it("hides another tenant's attempts behind 404", async () => {
    const { api, apps } = await setup();
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;
    const ingest = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, bKey),
    );
    const bMessageId = body(ingest).message.id;

    // A cannot read B's attempts — 404, not 403 (existence is not revealed).
    const aRead = await api(
      request({
        method: "GET",
        path: `/v1/messages/${bMessageId}/attempts`,
        headers: { authorization: `Bearer ${aKey}` },
      }),
    );
    expect(aRead.status).toBe(404);
  });
});

describe("createApi — POST /v1/messages/:id/retry (replay)", () => {
  /** Like setup(), but the queue dead-letters on the first failed attempt. */
  async function setupNoRetry(): Promise<Fixture> {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    return { apps, endpoints, messages, queue, attempts, api, appId: app.id, secret };
  }

  it("rejects an unauthenticated retry with 401", async () => {
    const { api } = await setupNoRetry();
    const res = await api(request({ method: "POST", path: "/v1/messages/msg_1/retry" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown message id", async () => {
    const { api, secret } = await setupNoRetry();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/messages/msg_missing/retry",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("hides another tenant's message behind 404", async () => {
    const { api, apps } = await setupNoRetry();
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;
    const ing = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, aKey),
    );
    const id = body(ing).message.id;

    // B cannot replay A's message — 404, not 403.
    const res = await api(
      request({
        method: "POST",
        path: `/v1/messages/${id}/retry`,
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("is a no-op (retried 0) when nothing has dead-lettered", async () => {
    const { api, secret } = await setupNoRetry();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const ing = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    const id = body(ing).message.id;

    const res = await api(
      request({
        method: "POST",
        path: `/v1/messages/${id}/retry`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).id).toBe(id);
    expect(body(res).retried).toBe(0);
    expect(body(res).deliveries).toHaveLength(1);
    expect(body(res).deliveries[0].status).toBe("pending"); // still being delivered automatically
  });

  it("replays a dead-lettered delivery, then the worker delivers it", async () => {
    const { api, secret, endpoints, messages, queue } = await setupNoRetry();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const ing = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { ok: true } },
        secret,
      ),
    );
    const id = body(ing).message.id;

    let receiverUp = false;
    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: receiverUp ? 200 : 500 }),
    });

    // Receiver down: the single attempt dead-letters.
    expect((await worker.processOnce()).deadLettered).toBe(1);
    const before = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(body(before).deliveries[0].status).toBe("dead_letter");

    // Replay it.
    const retry = await api(
      request({
        method: "POST",
        path: `/v1/messages/${id}/retry`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(retry.status).toBe(200);
    expect(body(retry).id).toBe(id);
    expect(body(retry).retried).toBe(1);
    expect(body(retry).deliveries[0].status).toBe("pending");
    expect(body(retry).deliveries[0].attempts).toBe(0);
    // Internal queue plumbing is never exposed, just like the read route.
    expect(body(retry).deliveries[0]).not.toHaveProperty("leaseToken");

    // Receiver fixed: the worker now delivers the replayed message.
    receiverUp = true;
    expect((await worker.processOnce()).succeeded).toBe(1);
    const after = await api(
      request({
        method: "GET",
        path: `/v1/messages/${id}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(body(after).deliveries[0].status).toBe("succeeded");
  });
});

describe("createApi — POST /v1/messages/:id/cancel", () => {
  /** Like setup(), but the queue dead-letters on the first failed attempt. */
  async function setupNoRetry(): Promise<Fixture> {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    return { apps, endpoints, messages, queue, attempts, api, appId: app.id, secret };
  }

  it("rejects unauthenticated with 401", async () => {
    const { api } = await setupNoRetry();
    const res = await api(request({ method: "POST", path: "/v1/messages/msg_1/cancel" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown message", async () => {
    const { api, secret } = await setupNoRetry();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/messages/msg_missing/cancel",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("hides another tenant's message behind 404", async () => {
    const { api, apps } = await setupNoRetry();
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;
    const ing = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, aKey),
    );
    const id = body(ing).message.id;

    // B cannot cancel A's message — 404, not 403.
    const res = await api(
      request({
        method: "POST",
        path: `/v1/messages/${id}/cancel`,
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("cancels pending deliveries and returns cancelled count + refreshed statuses", async () => {
    const { api, secret } = await setupNoRetry();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const ing = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    const id = body(ing).message.id;

    const res = await api(
      request({
        method: "POST",
        path: `/v1/messages/${id}/cancel`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).id).toBe(id);
    expect(body(res).cancelled).toBe(1);
    expect(body(res).deliveries).toHaveLength(1);
    expect(body(res).deliveries[0].status).toBe("cancelled");
    // Internal queue plumbing is never exposed.
    expect(body(res).deliveries[0]).not.toHaveProperty("leaseToken");
  });
});

describe("createApi — GET /v1/messages (list)", () => {
  /** Send `n` messages and return their refs ({ id, createdAt }) in send order. */
  async function send(
    api: ApiHandler,
    secret: string,
    n: number,
  ): Promise<{ id: string; createdAt: number }[]> {
    const refs: { id: string; createdAt: number }[] = [];
    for (let i = 0; i < n; i += 1) {
      const res = await api(
        jsonRequest("POST", "/v1/messages", { eventType: "e", payload: { i } }, secret),
      );
      refs.push({ id: body(res).message.id, createdAt: body(res).message.createdAt });
    }
    return refs;
  }

  /** Newest-first id order by the store's rule (createdAt desc, then id desc). */
  function expectedOrder(refs: { id: string; createdAt: number }[]): string[] {
    return [...refs]
      .sort((a, b) =>
        b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .map((m) => m.id);
  }

  function authedGet(
    api: ApiHandler,
    secret: string,
    query: Record<string, string> = {},
  ): Promise<ApiResponse> {
    return api(
      request({
        method: "GET",
        path: "/v1/messages",
        query,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
  }

  it("rejects an unauthenticated list with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/messages" }));
    expect(res.status).toBe(401);
  });

  it("returns an empty page when the tenant has no messages", async () => {
    const { api, secret } = await setup();
    const res = await authedGet(api, secret);
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ data: [], nextCursor: null });
  });

  it("lists the tenant's messages newest-first as lightweight summaries", async () => {
    const { api, secret } = await setup();
    const refs = await send(api, secret, 3);
    const res = await authedGet(api, secret);
    expect(res.status).toBe(200);
    expect(body(res).data.map((m: any) => m.id)).toEqual(expectedOrder(refs));
    expect(body(res).nextCursor).toBeNull();
    // A list item is a summary: no payload, no per-endpoint deliveries.
    const item = body(res).data[0];
    expect(item).toHaveProperty("eventType", "e");
    expect(item).toHaveProperty("createdAt");
    expect(item).not.toHaveProperty("payload");
    expect(item).not.toHaveProperty("deliveries");
  });

  it("pages through with limit + cursor, covering every message once", async () => {
    const { api, secret } = await setup();
    const refs = await send(api, secret, 5);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await authedGet(
        api,
        secret,
        cursor !== undefined ? { limit: "2", cursor } : { limit: "2" },
      );
      expect(res.status).toBe(200);
      seen.push(...body(res).data.map((m: any) => m.id));
      cursor = body(res).nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(seen).toEqual(expectedOrder(refs));
  });

  it("rejects an invalid ?limit= with 400", async () => {
    const { api, secret } = await setup();
    for (const limit of ["0", "-1", "abc", "1.5", "201"]) {
      const res = await authedGet(api, secret, { limit });
      expect(res.status).toBe(400);
      expect(body(res).error.code).toBe("invalid_request");
    }
  });

  it("rejects a malformed ?cursor= with 400", async () => {
    const { api, secret } = await setup();
    const res = await authedGet(api, secret, { cursor: "not-a-cursor!!" });
    expect(res.status).toBe(400);
  });

  it("never lists another tenant's messages", async () => {
    const { api, apps } = await setup();
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;

    const aRefs = await send(api, aKey, 2);
    await send(api, bKey, 3);

    const aList = await authedGet(api, aKey);
    expect(aList.status).toBe(200);
    expect(body(aList).data.map((m: any) => m.id).sort()).toEqual(
      aRefs.map((r) => r.id).sort(),
    );
  });

  it("filters by ?eventType= returning only matching messages", async () => {
    const { api, secret } = await setup();
    const ucRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "user.created", payload: {} }, secret),
    );
    const opRes = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "order.placed", payload: {} }, secret),
    );
    const ucId: string = body(ucRes).message.id;
    const opId: string = body(opRes).message.id;

    const filtered = await authedGet(api, secret, { eventType: "user.created" });
    expect(filtered.status).toBe(200);
    const ids = body(filtered).data.map((m: any) => m.id);
    expect(ids).toContain(ucId);
    expect(ids).not.toContain(opId);
  });

  it("returns an empty page when no messages match the ?eventType= filter", async () => {
    const { api, secret } = await setup();
    await send(api, secret, 2); // all have eventType "e"
    const res = await authedGet(api, secret, { eventType: "does.not.exist" });
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ data: [], nextCursor: null });
  });
});

describe("createApi — end-to-end with the delivery worker", () => {
  it("ingests over HTTP, then the worker delivers a request that verifies", async () => {
    const { api, secret, endpoints, messages, queue } = await setup();

    // Register an endpoint (subscribe to all) and keep its one-time secret.
    const created = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const endpointSecret: string = body(created).secret;

    // Ingest a message over the HTTP API.
    const ingestRes = await api(
      jsonRequest(
        "POST",
        "/v1/messages",
        { eventType: "user.created", payload: { id: 7 } },
        secret,
      ),
    );
    expect(ingestRes.status).toBe(202);
    expect(body(ingestRes).fanout.matched).toBe(1);

    // Drain the queue with a worker over a fake transport that captures the request.
    const captured: HttpDeliveryRequest[] = [];
    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async (req) => {
        captured.push(req);
        return { status: 200 };
      },
      // Use the real clock so the signed `webhook-timestamp` is within `verify`'s
      // replay window (which checks against wall-clock time).
    });
    const tick = await worker.processOnce();
    expect(tick.succeeded).toBe(1);

    // The worker-emitted, signed request verifies against the endpoint's secret.
    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.url).toBe("https://acme.example/hook");
    expect(() =>
      verify(
        endpointSecret,
        {
          id: sent.headers["webhook-id"]!,
          timestamp: sent.headers["webhook-timestamp"]!,
          signature: sent.headers["webhook-signature"]!,
        },
        sent.body,
      ),
    ).not.toThrow();
  });
});

describe("createApi — GET /metrics", () => {
  /** Build an API with metrics wired, plus a tenant + a matching endpoint. */
  async function setupWithMetrics() {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const metrics = new MetricsRegistry({ version: "9.9.9", now: () => 0 });
    const api = createApi({ apps, endpoints, messages, queue, attempts, metrics, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    await endpoints.create({
      appId: app.id,
      url: "https://acme.example/hook",
      eventTypes: ["user.created"],
    });
    return { api, metrics, secret };
  }

  it("serves Prometheus exposition unauthenticated with the right content type", async () => {
    const { api } = await setupWithMetrics();
    const res = await api(request({ method: "GET", path: "/metrics" }));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(typeof res.body).toBe("string");
    expect(res.body as string).toContain('posthorn_build_info{version="9.9.9"} 1');
  });

  it("reflects ingest activity in the counters", async () => {
    const { api, secret } = await setupWithMetrics();
    await api(jsonRequest("POST", "/v1/messages", { eventType: "user.created", payload: { a: 1 } }, secret));
    await api(jsonRequest("POST", "/v1/messages", { eventType: "user.created", payload: { a: 2 } }, secret));

    const res = await api(request({ method: "GET", path: "/metrics" }));
    const text = res.body as string;
    expect(text).toContain("posthorn_messages_ingested_total 2");
    // Two distinct messages fanned out to the one endpoint → two pending tasks.
    expect(text).toContain('posthorn_delivery_tasks{status="pending"} 2');
  });

  it("counts a deduplicated replay without re-fanning it out", async () => {
    const { api, secret } = await setupWithMetrics();
    const body = { eventType: "user.created", payload: { a: 1 }, idempotencyKey: "k1" };
    await api(jsonRequest("POST", "/v1/messages", body, secret));
    await api(jsonRequest("POST", "/v1/messages", body, secret)); // dedup replay

    const text = (await api(request({ method: "GET", path: "/metrics" }))).body as string;
    expect(text).toContain("posthorn_messages_ingested_total 2");
    expect(text).toContain("posthorn_messages_deduplicated_total 1");
    // The replay did not enqueue a second delivery.
    expect(text).toContain('posthorn_delivery_tasks{status="pending"} 1');
  });

  it("returns 404 when metrics are not wired", async () => {
    const { api } = await setup(); // the default fixture has no metrics
    const res = await api(request({ method: "GET", path: "/metrics" }));
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });
});

describe("createApi — admin / control-plane API", () => {
  const ADMIN_TOKEN = "test-admin-token-1234567890";

  interface AdminFixture {
    readonly apps: InMemoryAppStore;
    readonly api: ApiHandler;
  }

  /**
   * Build an API with the admin surface enabled, or disabled by passing `null`
   * (a `null` sentinel, not `undefined` — `undefined` would trigger the default).
   */
  function setupAdmin(adminToken: string | null = ADMIN_TOKEN): AdminFixture {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({
      apps,
      endpoints,
      messages,
      queue,
      attempts,
      eventTypes: new InMemoryEventTypeStore(),
      ...(adminToken !== null ? { adminToken } : {}),
    });
    return { apps, api };
  }

  /** An admin request (Bearer = the admin token), with an optional JSON body. */
  function adminRequest(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): ApiRequest {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return request({
      method,
      path,
      headers,
      rawBody: opts.body !== undefined ? JSON.stringify(opts.body) : "",
    });
  }

  /** Provision an app via the admin API and return its id. */
  async function createAppViaAdmin(api: ApiHandler, name?: string): Promise<string> {
    const res = await api(
      adminRequest("POST", "/v1/admin/apps", {
        token: ADMIN_TOKEN,
        ...(name !== undefined ? { body: { name } } : {}),
      }),
    );
    expect(res.status).toBe(201);
    return body(res).id as string;
  }

  /** A tenant-key GET /v1/endpoints, the cheapest proof a key authenticates. */
  function tenantProbe(api: ApiHandler, secret: string): Promise<ApiResponse> {
    return api(
      request({
        method: "GET",
        path: "/v1/endpoints",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
  }

  describe("disabled by default", () => {
    it("returns 404 (not 401) for every admin route when no admin token is configured", async () => {
      const { api } = setupAdmin(null);
      const probes: [string, string][] = [
        ["POST", "/v1/admin/apps"],
        ["GET", "/v1/admin/apps"],
        ["GET", "/v1/admin/apps/app_x"],
        ["PATCH", "/v1/admin/apps/app_x"],
        ["DELETE", "/v1/admin/apps/app_x"],
        ["POST", "/v1/admin/apps/app_x/keys"],
        ["GET", "/v1/admin/apps/app_x/keys"],
        ["POST", "/v1/admin/apps/app_x/rotate-system-secret"],
        ["DELETE", "/v1/admin/keys/ak_x"],
      ];
      for (const [method, path] of probes) {
        // Presenting a token must NOT reveal the surface exists on a disabled instance.
        const res = await api(adminRequest(method, path, { token: ADMIN_TOKEN }));
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(body(res).error.code, `${method} ${path}`).toBe("not_found");
      }
    });
  });

  describe("admin-token authentication", () => {
    it("rejects a missing token with 401 + WWW-Authenticate", async () => {
      const { api } = setupAdmin();
      const res = await api(adminRequest("GET", "/v1/admin/apps"));
      expect(res.status).toBe(401);
      expect(body(res).error.code).toBe("unauthorized");
      expect(res.headers?.["www-authenticate"]).toBe("Bearer");
    });

    it("rejects a wrong token with 401", async () => {
      const { api } = setupAdmin();
      const res = await api(
        adminRequest("GET", "/v1/admin/apps", { token: "wrong-but-long-enough-xxxx" }),
      );
      expect(res.status).toBe(401);
    });

    it("does not accept a tenant API key as the admin token", async () => {
      const { api, apps } = setupAdmin();
      const app = await apps.create({ name: "Acme" });
      const { secret: tenantKey } = await apps.createApiKey(app.id);
      const res = await api(adminRequest("GET", "/v1/admin/apps", { token: tenantKey }));
      expect(res.status).toBe(401);
    });
  });

  describe("provisioning (authenticated)", () => {
    it("creates an app (named and unnamed), lists, and fetches it without leaking secrets", async () => {
      const { api } = setupAdmin();

      const appId = await createAppViaAdmin(api, "Acme");
      expect(appId).toMatch(/^app_/);

      // No body → unnamed app.
      const unnamed = await api(adminRequest("POST", "/v1/admin/apps", { token: ADMIN_TOKEN }));
      expect(unnamed.status).toBe(201);
      expect(body(unnamed).name).toBe("");

      const list = await api(adminRequest("GET", "/v1/admin/apps", { token: ADMIN_TOKEN }));
      expect(list.status).toBe(200);
      expect((body(list).data as unknown[]).length).toBe(2);

      const got = await api(adminRequest("GET", `/v1/admin/apps/${appId}`, { token: ADMIN_TOKEN }));
      expect(got.status).toBe(200);
      // The view is exactly identity + label + quota + timestamps — no secret material.
      expect(body(got)).toEqual({
        id: appId,
        name: "Acme",
        monthlyMessageQuota: null,
        systemWebhookUrl: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
    });

    it("400s a non-string app name", async () => {
      const { api } = setupAdmin();
      const res = await api(
        adminRequest("POST", "/v1/admin/apps", { token: ADMIN_TOKEN, body: { name: 123 } }),
      );
      expect(res.status).toBe(400);
      expect(body(res).error.code).toBe("invalid_request");
    });

    it("404s fetching an unknown app", async () => {
      const { api } = setupAdmin();
      const res = await api(adminRequest("GET", "/v1/admin/apps/app_nope", { token: ADMIN_TOKEN }));
      expect(res.status).toBe(404);
    });

    it("creates a tenant with a monthly quota and exposes it in the view", async () => {
      const { api } = setupAdmin();
      const res = await api(
        adminRequest("POST", "/v1/admin/apps", {
          token: ADMIN_TOKEN,
          body: { name: "Pro", monthlyMessageQuota: 1000 },
        }),
      );
      expect(res.status).toBe(201);
      expect(body(res).monthlyMessageQuota).toBe(1000);
    });

    it("PATCH sets, changes, and clears the monthly quota; a name-only patch leaves it", async () => {
      const { api } = setupAdmin();
      const appId = await createAppViaAdmin(api, "Acme");

      // A fresh app is unlimited.
      const before = await api(
        adminRequest("GET", `/v1/admin/apps/${appId}`, { token: ADMIN_TOKEN }),
      );
      expect(body(before).monthlyMessageQuota).toBeNull();

      // Set a quota (a plan upgrade).
      const capped = await api(
        adminRequest("PATCH", `/v1/admin/apps/${appId}`, {
          token: ADMIN_TOKEN,
          body: { monthlyMessageQuota: 1000 },
        }),
      );
      expect(capped.status).toBe(200);
      expect(body(capped).monthlyMessageQuota).toBe(1000);

      // A name-only patch leaves the quota in place.
      const renamed = await api(
        adminRequest("PATCH", `/v1/admin/apps/${appId}`, {
          token: ADMIN_TOKEN,
          body: { name: "Acme Inc" },
        }),
      );
      expect(body(renamed).name).toBe("Acme Inc");
      expect(body(renamed).monthlyMessageQuota).toBe(1000);

      // null removes the limit again — durably.
      const lifted = await api(
        adminRequest("PATCH", `/v1/admin/apps/${appId}`, {
          token: ADMIN_TOKEN,
          body: { monthlyMessageQuota: null },
        }),
      );
      expect(body(lifted).monthlyMessageQuota).toBeNull();
      const after = await api(
        adminRequest("GET", `/v1/admin/apps/${appId}`, { token: ADMIN_TOKEN }),
      );
      expect(body(after).monthlyMessageQuota).toBeNull();
    });

    it("400s a negative or non-integer quota patch", async () => {
      const { api } = setupAdmin();
      const appId = await createAppViaAdmin(api);
      for (const bad of [-1, 1.5, "100"]) {
        const res = await api(
          adminRequest("PATCH", `/v1/admin/apps/${appId}`, {
            token: ADMIN_TOKEN,
            body: { monthlyMessageQuota: bad },
          }),
        );
        expect(res.status, `quota=${bad}`).toBe(400);
        expect(body(res).error.code).toBe("invalid_request");
      }
    });

    it("404s patching an unknown app", async () => {
      const { api } = setupAdmin();
      const res = await api(
        adminRequest("PATCH", "/v1/admin/apps/app_nope", {
          token: ADMIN_TOKEN,
          body: { name: "x" },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("mints a key whose secret is shown once and then authenticates a tenant route", async () => {
      const { api } = setupAdmin();
      const appId = await createAppViaAdmin(api, "Acme");

      const minted = await api(
        adminRequest("POST", `/v1/admin/apps/${appId}/keys`, { token: ADMIN_TOKEN }),
      );
      expect(minted.status).toBe(201);
      const secret = body(minted).secret as string;
      expect(secret).toMatch(/^phk_/);
      expect(body(minted).apiKey.appId).toBe(appId);
      // The metadata view never carries the secret itself.
      expect(body(minted).apiKey.secret).toBeUndefined();

      // The minted secret is a working tenant credential, end-to-end.
      const probe = await tenantProbe(api, secret);
      expect(probe.status).toBe(200);
      expect(body(probe).data).toEqual([]);
    });

    it("lists keys (empty vs populated, metadata-only) and 404s an unknown app", async () => {
      const { api } = setupAdmin();
      const appId = await createAppViaAdmin(api);

      const empty = await api(
        adminRequest("GET", `/v1/admin/apps/${appId}/keys`, { token: ADMIN_TOKEN }),
      );
      expect(empty.status).toBe(200);
      expect(body(empty).data).toEqual([]);

      await api(adminRequest("POST", `/v1/admin/apps/${appId}/keys`, { token: ADMIN_TOKEN }));
      const populated = await api(
        adminRequest("GET", `/v1/admin/apps/${appId}/keys`, { token: ADMIN_TOKEN }),
      );
      expect((body(populated).data as unknown[]).length).toBe(1);
      expect(body(populated).data[0].secret).toBeUndefined();
      expect(body(populated).data[0].prefix).toMatch(/^phk_/);

      const unknown = await api(
        adminRequest("GET", "/v1/admin/apps/app_nope/keys", { token: ADMIN_TOKEN }),
      );
      expect(unknown.status).toBe(404);
    });

    it("404s minting a key for an unknown app", async () => {
      const { api } = setupAdmin();
      const res = await api(
        adminRequest("POST", "/v1/admin/apps/app_nope/keys", { token: ADMIN_TOKEN }),
      );
      expect(res.status).toBe(404);
    });

    it("revokes a key (204); afterwards it no longer authenticates, and re-revoke is 404", async () => {
      const { api } = setupAdmin();
      const appId = await createAppViaAdmin(api);
      const minted = await api(
        adminRequest("POST", `/v1/admin/apps/${appId}/keys`, { token: ADMIN_TOKEN }),
      );
      const secret = body(minted).secret as string;
      const keyId = body(minted).apiKey.id as string;

      expect((await tenantProbe(api, secret)).status).toBe(200);

      const revoked = await api(
        adminRequest("DELETE", `/v1/admin/keys/${keyId}`, { token: ADMIN_TOKEN }),
      );
      expect(revoked.status).toBe(204);

      expect((await tenantProbe(api, secret)).status).toBe(401);

      // Re-revoking (or an unknown id) is 404.
      expect(
        (await api(adminRequest("DELETE", `/v1/admin/keys/${keyId}`, { token: ADMIN_TOKEN }))).status,
      ).toBe(404);
      expect(
        (await api(adminRequest("DELETE", "/v1/admin/keys/ak_nope", { token: ADMIN_TOKEN }))).status,
      ).toBe(404);
    });

    it("deletes an app (204) and cascades its keys (the key stops authenticating)", async () => {
      const { api } = setupAdmin();
      const appId = await createAppViaAdmin(api);
      const secret = body(
        await api(adminRequest("POST", `/v1/admin/apps/${appId}/keys`, { token: ADMIN_TOKEN })),
      ).secret as string;

      const del = await api(adminRequest("DELETE", `/v1/admin/apps/${appId}`, { token: ADMIN_TOKEN }));
      expect(del.status).toBe(204);

      // The app is gone…
      expect(
        (await api(adminRequest("GET", `/v1/admin/apps/${appId}`, { token: ADMIN_TOKEN }))).status,
      ).toBe(404);
      // …and its key was cascade-removed, so it no longer authenticates.
      expect((await tenantProbe(api, secret)).status).toBe(401);

      // Deleting again is 404.
      expect(
        (await api(adminRequest("DELETE", `/v1/admin/apps/${appId}`, { token: ADMIN_TOKEN }))).status,
      ).toBe(404);
    });
  });
});

describe("createApi — GET /v1/admin/apps/:id/usage", () => {
  const ADMIN_TOKEN = "test-admin-token-1234567890";

  interface UsageFixture {
    readonly api: ApiHandler;
    readonly appId: string;
    readonly messages: InMemoryMessageStore;
    readonly attempts: InMemoryDeliveryAttemptStore;
    advance(ms: number): void;
  }

  /** Build a usage-enabled API over a clock I can advance to place messages on UTC days. */
  async function setup(adminEnabled = true): Promise<UsageFixture> {
    let nowMs = Date.UTC(2026, 4, 10, 12, 0, 0); // 2026-05-10T12:00:00Z
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({
      apps,
      endpoints,
      messages,
      queue,
      attempts,
      eventTypes: new InMemoryEventTypeStore(),
      ...(adminEnabled ? { adminToken: ADMIN_TOKEN } : {}),
    });
    const app = await apps.create({ name: "Acme" });
    return {
      api,
      appId: app.id,
      messages,
      attempts,
      advance: (ms) => {
        nowMs += ms;
      },
    };
  }

  /** A GET /v1/admin/apps/:id/usage request with query params and (default admin) auth. */
  function usageRequest(
    appId: string,
    query: Record<string, string>,
    token: string | null = ADMIN_TOKEN,
  ): ApiRequest {
    return request({
      method: "GET",
      path: `/v1/admin/apps/${appId}/usage`,
      query,
      headers: token !== null ? { authorization: `Bearer ${token}` } : {},
    });
  }

  const DAY_MS = 86_400_000;

  it("is 404 (surface hidden) when the admin API is disabled", async () => {
    const { api, appId } = await setup(false);
    const res = await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-10" }));
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("rejects a missing or wrong admin token with 401", async () => {
    const { api, appId } = await setup();
    expect((await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-10" }, null))).status).toBe(401);
    expect(
      (await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-10" }, "wrong-but-long-enough-xx"))).status,
    ).toBe(401);
  });

  it("is 404 for an unknown tenant", async () => {
    const { api } = await setup();
    const res = await api(usageRequest("app_nope", { from: "2026-05-10", to: "2026-05-10" }));
    expect(res.status).toBe(404);
  });

  it("400s on missing/invalid from or to, an inverted range, or a range over the day cap", async () => {
    const { api, appId } = await setup();
    expect((await api(usageRequest(appId, { to: "2026-05-10" }))).status).toBe(400); // missing from
    expect((await api(usageRequest(appId, { from: "2026-05-10" }))).status).toBe(400); // missing to
    expect((await api(usageRequest(appId, { from: "05/10/2026", to: "2026-05-10" }))).status).toBe(400); // bad shape
    expect((await api(usageRequest(appId, { from: "2026-02-30", to: "2026-03-01" }))).status).toBe(400); // invalid date
    expect((await api(usageRequest(appId, { from: "2026-05-11", to: "2026-05-10" }))).status).toBe(400); // inverted
    expect((await api(usageRequest(appId, { from: "2020-01-01", to: "2026-01-01" }))).status).toBe(400); // > cap
  });

  it("returns a zero summary for a tenant with no messages", async () => {
    const { api, appId } = await setup();
    const res = await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-12" }));
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      appId,
      from: "2026-05-10",
      to: "2026-05-12",
      total: 0,
      daily: [],
      deliveries: { total: 0, succeeded: 0, failed: 0, daily: [] },
    });
  });

  it("reports per-UTC-day counts and a total over the inclusive range", async () => {
    const { api, appId, messages, advance } = await setup();
    // Two messages on 2026-05-10, one on 2026-05-11.
    await messages.create({ appId, eventType: "e", payload: "{}" });
    await messages.create({ appId, eventType: "e", payload: "{}" });
    advance(DAY_MS);
    await messages.create({ appId, eventType: "e", payload: "{}" });

    const res = await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-11" }));
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      appId,
      from: "2026-05-10",
      to: "2026-05-11",
      total: 3,
      daily: [
        { date: "2026-05-10", messages: 2 },
        { date: "2026-05-11", messages: 1 },
      ],
      deliveries: { total: 0, succeeded: 0, failed: 0, daily: [] },
    });

    // The `to` day is inclusive but a single-day window past it excludes the older day.
    const justDay2 = await api(usageRequest(appId, { from: "2026-05-11", to: "2026-05-11" }));
    expect(body(justDay2).total).toBe(1);
    expect(body(justDay2).daily).toEqual([{ date: "2026-05-11", messages: 1 }]);
  });

  it("reports per-tenant delivery-attempt (operations) usage over the range", async () => {
    const { api, appId, attempts } = await setup();
    const day1 = Date.UTC(2026, 4, 10, 8, 0, 0); // 2026-05-10
    const day2 = Date.UTC(2026, 4, 11, 8, 0, 0); // 2026-05-11
    // Day 1: 1 succeeded + 1 failed; day 2: 1 succeeded — for this tenant.
    await attempts.record({ taskId: "t1", messageId: "m1", appId, attemptNumber: 1, outcome: "succeeded", durationMs: 5, attemptedAt: day1 });
    await attempts.record({ taskId: "t1", messageId: "m1", appId, attemptNumber: 2, outcome: "failed", responseStatus: 500, error: "x", durationMs: 5, attemptedAt: day1 + 1 });
    await attempts.record({ taskId: "t2", messageId: "m2", appId, attemptNumber: 1, outcome: "succeeded", durationMs: 5, attemptedAt: day2 });
    // A different tenant's attempt must not leak in.
    await attempts.record({ taskId: "t3", messageId: "m3", appId: "app_other", attemptNumber: 1, outcome: "succeeded", durationMs: 5, attemptedAt: day1 });

    const b = body(await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-11" })));
    expect(b.deliveries).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
      daily: [
        { date: "2026-05-10", attempts: 2, succeeded: 1, failed: 1 },
        { date: "2026-05-11", attempts: 1, succeeded: 1, failed: 0 },
      ],
    });
  });

  it("never counts another tenant's messages", async () => {
    const { api, appId, messages } = await setup();
    await messages.create({ appId, eventType: "e", payload: "{}" });
    // Another tenant's traffic in the same store must not leak into this app's usage.
    await messages.create({ appId: "app_other", eventType: "e", payload: "{}" });
    await messages.create({ appId: "app_other", eventType: "e", payload: "{}" });

    const mine = await api(usageRequest(appId, { from: "2026-05-10", to: "2026-05-10" }));
    expect(body(mine).total).toBe(1);
  });
});

describe("createApi — GET /v1/endpoints/:id/deliveries (endpoint delivery history)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/endpoints/ep_1/deliveries" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown endpoint id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints/ep_unknown/deliveries",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("returns an empty page for an endpoint with no deliveries", async () => {
    const { api, secret } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/deliveries`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual([]);
    expect(body(res).nextCursor).toBeNull();
  });

  it("lists deliveries newest-first with messageId included", async () => {
    const { api, secret, endpoints, messages, queue } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    // Ingest two messages; fan-out enqueues one delivery each.
    const r1 = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "a", payload: {} }, secret),
    );
    const r2 = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "b", payload: {} }, secret),
    );
    const msgId1: string = body(r1).message.id;
    const msgId2: string = body(r2).message.id;

    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/deliveries`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    const data = body(res).data as Record<string, unknown>[];
    expect(data).toHaveLength(2);
    // Both message IDs appear (ordering may depend on the createdAt tiebreak).
    const returnedIds = data.map((d) => d["messageId"]);
    expect(returnedIds).toContain(msgId1);
    expect(returnedIds).toContain(msgId2);
    // Each delivery carries the endpoint id and status fields.
    expect(data[0]!["endpointId"]).toBe(epId);
    expect(data[0]!["status"]).toBe("pending");
    expect(data[0]!).toHaveProperty("attempts");
    expect(data[0]!).toHaveProperty("createdAt");
    expect(data[0]!).toHaveProperty("updatedAt");
    // Internal fields are not leaked.
    expect(data[0]!).not.toHaveProperty("leaseToken");
    expect(data[0]!).not.toHaveProperty("leaseExpiresAt");
    // nextCursor is null (only 2 items, fits in one page).
    expect(body(res).nextCursor).toBeNull();
  });

  it("paginates correctly via cursor", async () => {
    const { api, secret } = await setup();
    await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    // Ingest 3 messages.
    for (let i = 0; i < 3; i++) {
      await api(
        jsonRequest("POST", "/v1/messages", { eventType: `e${i}`, payload: {} }, secret),
      );
    }
    const ep = await api(
      request({ method: "GET", path: "/v1/endpoints", headers: { authorization: `Bearer ${secret}` } }),
    );
    const epId: string = body(ep).data[0].id;

    // First page (limit=2).
    const first = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/deliveries`,
        headers: { authorization: `Bearer ${secret}` },
        query: { limit: "2" },
      }),
    );
    expect(body(first).data).toHaveLength(2);
    expect(body(first).nextCursor).not.toBeNull();

    // Second page.
    const cursor: string = body(first).nextCursor;
    const second = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/deliveries`,
        headers: { authorization: `Bearer ${secret}` },
        query: { limit: "2", cursor },
      }),
    );
    expect(body(second).data).toHaveLength(1);
    expect(body(second).nextCursor).toBeNull();
  });

  it("hides another tenant's endpoint behind 404", async () => {
    const { api, apps } = await setup();
    const a = await apps.create({ name: "A" });
    const b = await apps.create({ name: "B" });
    const aKey = (await apps.createApiKey(a.id)).secret;
    const bKey = (await apps.createApiKey(b.id)).secret;
    // Tenant B creates an endpoint.
    const bEp = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://b.example/hook" }, bKey),
    );
    const bEpId: string = body(bEp).id;

    // Tenant A cannot see B's endpoint deliveries — 404, not 403.
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${bEpId}/deliveries`,
        headers: { authorization: `Bearer ${aKey}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid limit", async () => {
    const { api, secret } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/deliveries`,
        headers: { authorization: `Bearer ${secret}` },
        query: { limit: "0" },
      }),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });
});

describe("createApi — GET /v1/endpoints/:id/stats (endpoint delivery statistics)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/endpoints/ep_1/stats" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown or another tenant's endpoint", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/endpoints/ep_unknown/stats",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns zero stats when the endpoint has no recorded attempts", async () => {
    const { api, secret } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/stats`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    const stats = body(res);
    expect(stats.endpointId).toBe(epId);
    expect(stats.total).toBe(0);
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBeNull();
    expect(stats.avgDurationMs).toBeNull();
    expect(stats.daily).toEqual([]);
  });

  it("counts attempts for the endpoint and computes successRate + avgDurationMs", async () => {
    const { api, secret, attempts, appId } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    const nowMs = Date.now();
    // Record 3 succeeded (dur 100ms each) + 1 failed (dur 200ms) within the window.
    for (let i = 0; i < 3; i++) {
      await attempts.record({
        taskId: `task_${i}`,
        messageId: `msg_${i}`,
        appId,
        endpointId: epId,
        attemptNumber: 1,
        outcome: "succeeded",
        responseStatus: 200,
        durationMs: 100,
        attemptedAt: nowMs - 1000 * (i + 1),
      });
    }
    await attempts.record({
      taskId: "task_fail",
      messageId: "msg_fail",
      appId,
      endpointId: epId,
      attemptNumber: 1,
      outcome: "failed",
      responseStatus: 500,
      error: "internal error",
      durationMs: 200,
      attemptedAt: nowMs - 5000,
    });
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/stats`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    const stats = body(res);
    expect(stats.total).toBe(4);
    expect(stats.succeeded).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBe(0.75);
    // (100 * 3 + 200) / 4 = 125
    expect(stats.avgDurationMs).toBe(125);
    expect(stats.daily.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an out-of-range ?days= with 400", async () => {
    const { api, secret } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    const res = await api(
      request({
        method: "GET",
        path: `/v1/endpoints/${epId}/stats`,
        headers: { authorization: `Bearer ${secret}` },
        query: { days: "0" },
      }),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });
});

describe("createApi — GET /v1/deliveries (app-wide delivery listing)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/deliveries" }));
    expect(res.status).toBe(401);
  });

  it("returns an empty page when the tenant has no deliveries", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({ method: "GET", path: "/v1/deliveries", headers: { authorization: `Bearer ${secret}` } }),
    );
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ data: [], nextCursor: null });
  });

  it("lists deliveries with messageId and endpointId present", async () => {
    const { api, secret } = await setup();
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret),
    );
    const epId: string = body(ep).id;
    const msg = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret),
    );
    const msgId: string = body(msg).message.id;

    const res = await api(
      request({ method: "GET", path: "/v1/deliveries", headers: { authorization: `Bearer ${secret}` } }),
    );
    expect(res.status).toBe(200);
    const data = body(res).data as Record<string, unknown>[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ messageId: msgId, endpointId: epId });
    expect(data[0]).toHaveProperty("status");
    expect(data[0]).toHaveProperty("attempts");
    expect(body(res).nextCursor).toBeNull();
  });

  it("filters by status — dead_letter only, pending empty", async () => {
    // Use a 0-retry queue so one fail → dead_letter immediately.
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const attempts = new InMemoryDeliveryAttemptStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Test" });
    const { secret } = await apps.createApiKey(app.id);

    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook" }, secret));
    await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));

    // One claim + fail = dead_letter with 0 retries.
    const nowMs = Date.now();
    const batch = await queue.claimDue({ nowMs });
    for (const t of batch) {
      await queue.fail(t.id, t.leaseToken!, { error: "x", nowMs });
    }

    const dead = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${secret}` },
        query: { status: "dead_letter" },
      }),
    );
    expect(dead.status).toBe(200);
    const deadData = body(dead).data as Record<string, unknown>[];
    expect(deadData.length).toBe(1);
    expect(deadData[0]!["status"]).toBe("dead_letter");

    const pending = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${secret}` },
        query: { status: "pending" },
      }),
    );
    expect(pending.status).toBe(200);
    expect((body(pending).data as unknown[]).length).toBe(0);
  });

  it("paginates correctly via cursor", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook" }, secret));
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://b.example/hook" }, secret));
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://c.example/hook" }, secret));
    await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));

    const first = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${secret}` },
        query: { limit: "2" },
      }),
    );
    expect(first.status).toBe(200);
    expect((body(first).data as unknown[]).length).toBe(2);
    expect(body(first).nextCursor).not.toBeNull();

    const second = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${secret}` },
        query: { limit: "2", cursor: body(first).nextCursor as string },
      }),
    );
    expect(second.status).toBe(200);
    expect((body(second).data as unknown[]).length).toBe(1);
    expect(body(second).nextCursor).toBeNull();
  });

  it("tenant isolation — tenant B sees no deliveries from tenant A", async () => {
    const { apps, api } = await setup();
    const aApp = await apps.create({ name: "A" });
    const { secret: aKey } = await apps.createApiKey(aApp.id);
    const bApp = await apps.create({ name: "B" });
    const { secret: bKey } = await apps.createApiKey(bApp.id);

    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook" }, aKey));
    await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, aKey));

    const res = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ data: [], nextCursor: null });
  });

  it("returns 400 for an invalid limit", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${secret}` },
        query: { limit: "0" },
      }),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("returns 400 for an unrecognised status value", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/deliveries",
        headers: { authorization: `Bearer ${secret}` },
        query: { status: "nope" },
      }),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });
});

describe("createApi — POST /v1/deliveries/retry (bulk dead-letter retry)", () => {
  /** Queue that dead-letters on the first failure (no automatic retries). */
  async function setupNoRetry() {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    return { apps, endpoints, messages, queue, attempts, api, appId: app.id, secret };
  }

  it("rejects an unauthenticated request with 401", async () => {
    const { api } = await setupNoRetry();
    const res = await api(request({ method: "POST", path: "/v1/deliveries/retry" }));
    expect(res.status).toBe(401);
  });

  it("returns { retried: 0, hasMore: false } when no deliveries are dead-lettered", async () => {
    const { api, secret } = await setupNoRetry();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/deliveries/retry",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ retried: 0, hasMore: false });
  });

  it("revives dead-lettered deliveries and returns the count", async () => {
    const { api, secret, endpoints, messages, queue } = await setupNoRetry();
    // Register two endpoints.
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep1" }, secret));
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep2" }, secret));
    // Send a message — fans out to both endpoints.
    await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));

    // Drive both deliveries to dead_letter (receiver always 500, no retries).
    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: 500 }),
    });
    await worker.processOnce(); // both fail → dead_letter

    const res = await api(
      request({
        method: "POST",
        path: "/v1/deliveries/retry",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).retried).toBe(2);
    expect(body(res).hasMore).toBe(false);
  });

  it("does not touch another tenant's deliveries", async () => {
    const { api: apiA, apps, endpoints, messages, queue, attempts } = await setupNoRetry();
    const eventTypes = new InMemoryEventTypeStore();
    // Provision tenant B using the same underlying stores.
    const appB = await apps.create({ name: "B" });
    const bKey = (await apps.createApiKey(appB.id)).secret;
    const apiB = createApi({ apps, endpoints, messages, queue, attempts, eventTypes });

    // Tenant A sends a message with an endpoint.
    const { secret: aKey } = await apps.createApiKey((await apps.create({ name: "A" })).id);
    await apiA(jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook" }, aKey));
    await apiA(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, aKey));

    // No dead-letter tasks for tenant B yet.
    const res = await apiB(
      request({
        method: "POST",
        path: "/v1/deliveries/retry",
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).retried).toBe(0);
  });
});

describe("createApi — POST /v1/endpoints/:id/deliveries/retry (per-endpoint bulk retry)", () => {
  async function setupNoRetry() {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    return { apps, endpoints, messages, queue, attempts, api, appId: app.id, secret };
  }

  it("rejects an unauthenticated request with 401", async () => {
    const { api, endpoints, secret } = await setupNoRetry();
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    const res = await api(request({ method: "POST", path: `/v1/endpoints/${epId}/deliveries/retry` }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown endpoint id", async () => {
    const { api, secret } = await setupNoRetry();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/endpoints/ep_unknown/deliveries/retry",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns { retried: 0, hasMore: false } when no deliveries are dead-lettered", async () => {
    const { api, secret } = await setupNoRetry();
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${epId}/deliveries/retry`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ retried: 0, hasMore: false });
  });

  it("revives dead-lettered deliveries for the endpoint and returns the count", async () => {
    const { api, secret, endpoints, messages, queue } = await setupNoRetry();
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));

    const worker = new DeliveryWorker({
      queue,
      store: messages,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport: async () => ({ status: 500 }),
    });
    await worker.processOnce();

    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${epId}/deliveries/retry`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).retried).toBe(1);
    expect(body(res).hasMore).toBe(false);
  });
});

describe("createApi — POST /v1/endpoints/:id/replay (endpoint message replay)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { api, endpoints, secret } = await setup();
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    const res = await api(request({ method: "POST", path: `/v1/endpoints/${epId}/replay` }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown endpoint id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/endpoints/ep_unknown/replay",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the endpoint belongs to another tenant", async () => {
    const { apps, api } = await setup();
    const other = await apps.create({ name: "Other" });
    const otherEndpoints = new InMemoryEndpointStore();
    const otherEp = await otherEndpoints.create({
      appId: other.id,
      url: "https://other.example/hook",
    });
    const { secret: mySecret } = await apps.createApiKey((await apps.create({ name: "Mine" })).id);
    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${otherEp.id}/replay`,
        headers: { authorization: `Bearer ${mySecret}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns { enqueued: 0, hasMore: false } when there are no messages", async () => {
    const { api, secret } = await setup();
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${epId}/replay`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ enqueued: 0, hasMore: false });
  });

  it("enqueues a task for a matching message and returns the count", async () => {
    const { api, secret, queue, appId } = await setup();
    await api(jsonRequest("POST", "/v1/messages", { eventType: "order.placed", payload: {} }, secret));
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${epId}/replay`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).enqueued).toBe(1);
    expect(body(res).hasMore).toBe(false);
    const tasks = (await queue.listByApp(appId)).deliveries;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.endpointId).toBe(epId);
  });

  it("respects event-type subscription — skips non-subscribed messages", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/messages", { eventType: "user.created", payload: {} }, secret));
    await api(jsonRequest("POST", "/v1/messages", { eventType: "payment.done", payload: {} }, secret));
    const ep = await api(
      jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep", eventTypes: ["user.created"] }, secret),
    );
    const epId = body(ep).id as string;
    const res = await api(
      request({
        method: "POST",
        path: `/v1/endpoints/${epId}/replay`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).enqueued).toBe(1);
  });

  it("respects since / until time-range bounds in the request body", async () => {
    const clockMs = { value: 1_700_000_000_000 };
    const now = () => clockMs.value;
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now });
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes, now });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);

    // old message — before the window
    await messages.create({ appId: app.id, eventType: "ping", payload: "{}" });
    clockMs.value += 5_000;
    const sinceMs = clockMs.value;
    clockMs.value += 1_000;
    // message inside the window
    await messages.create({ appId: app.id, eventType: "ping", payload: "{}" });
    clockMs.value += 1_000;
    const untilMs = clockMs.value;
    clockMs.value += 1_000;
    // message after the window
    await messages.create({ appId: app.id, eventType: "ping", payload: "{}" });

    const ep = await endpoints.create({ appId: app.id, url: "https://acme.example/ep" });
    const res = await api(
      jsonRequest(
        "POST",
        `/v1/endpoints/${ep.id}/replay`,
        { since: sinceMs, until: untilMs },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    expect(body(res).enqueued).toBe(1);
  });

  it("returns 400 for an out-of-range limit", async () => {
    const { api, secret } = await setup();
    const ep = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/ep" }, secret));
    const epId = body(ep).id as string;
    const res = await api(
      jsonRequest("POST", `/v1/endpoints/${epId}/replay`, { limit: 99999 }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });
});

describe("createApi — POST /v1/portal/sessions (portal session minting)", () => {
  async function portalSetup() {
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore();
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const portalSessions = new InMemoryPortalSessionStore();
    const now = () => 1_700_000_000_000;
    const api = createApi({ apps, endpoints, messages, queue, attempts, portalSessions, now, eventTypes: new InMemoryEventTypeStore() });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    return { api, secret, portalSessions };
  }

  it("returns 401 for an unauthenticated request", async () => {
    const { api } = await portalSetup();
    const res = await api(jsonRequest("POST", "/v1/portal/sessions", { externalUserId: "u1" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when portalSessions is not configured", async () => {
    const { api, secret } = await setup();
    const res = await api(jsonRequest("POST", "/v1/portal/sessions", { externalUserId: "u1" }, secret));
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("returns 400 for a missing externalUserId", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(jsonRequest("POST", "/v1/portal/sessions", {}, secret));
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("returns 400 for a blank externalUserId", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(jsonRequest("POST", "/v1/portal/sessions", { externalUserId: "   " }, secret));
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("returns 201 with token, portalUrl, and expiresAt on a valid request", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(
      jsonRequest("POST", "/v1/portal/sessions", { externalUserId: "user-123" }, secret),
    );
    expect(res.status).toBe(201);
    const b = body(res);
    expect(typeof b.token).toBe("string");
    expect(b.token.length).toBeGreaterThan(0);
    expect(b.portalUrl).toContain("/portal/login?token=");
    expect(b.portalUrl).toContain(b.token);
    // Default TTL = 24 h = 86400 s; nowMs fixed at 1_700_000_000_000
    expect(b.expiresAt).toBe(1_700_000_000_000 + 86_400 * 1000);
  });

  it("respects a custom expiresIn (seconds)", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(
      jsonRequest("POST", "/v1/portal/sessions", { externalUserId: "user-abc", expiresIn: 3600 }, secret),
    );
    expect(res.status).toBe(201);
    const b = body(res);
    expect(b.expiresAt).toBe(1_700_000_000_000 + 3600 * 1000);
  });

  it("returns 400 when expiresIn exceeds the 7-day maximum", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/portal/sessions",
        { externalUserId: "u", expiresIn: 7 * 24 * 60 * 60 + 1 },
        secret,
      ),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("returns 400 when expiresIn is zero or negative", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(
      jsonRequest("POST", "/v1/portal/sessions", { externalUserId: "u", expiresIn: 0 }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("derives portalUrl proto from x-forwarded-proto header", async () => {
    const { api, secret } = await portalSetup();
    const res = await api(
      request({
        method: "POST",
        path: "/v1/portal/sessions",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          host: "hooks.example.com",
        },
        rawBody: JSON.stringify({ externalUserId: "u" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(body(res).portalUrl).toMatch(/^https:\/\/hooks\.example\.com\/portal\/login\?token=/);
  });
});

describe("createApi — event types", () => {
  it("creates an event type and returns 201", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/event-types",
        { id: "user.created", name: "User Created", description: "A user was created" },
        secret,
      ),
    );
    expect(res.status).toBe(201);
    expect(body(res).id).toBe("user.created");
    expect(body(res).name).toBe("User Created");
    expect(body(res).description).toBe("A user was created");
    expect(body(res).archived).toBe(false);
  });

  it("returns 409 for duplicate event type id", async () => {
    const { api, secret } = await setup();
    await api(
      jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created" }, secret),
    );
    const res = await api(
      jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created v2" }, secret),
    );
    expect(res.status).toBe(409);
    expect(body(res).error.code).toBe("conflict");
  });

  it("lists event types, excludes archived by default", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created" }, secret));
    await api(jsonRequest("POST", "/v1/event-types", { id: "payment.failed", name: "Payment Failed" }, secret));
    await api(request({ method: "DELETE", path: "/v1/event-types/payment.failed", headers: { authorization: `Bearer ${secret}` } }));

    const res = await api(request({ method: "GET", path: "/v1/event-types", headers: { authorization: `Bearer ${secret}` } }));
    expect(res.status).toBe(200);
    expect(body(res).data).toHaveLength(1);
    expect(body(res).data[0].id).toBe("user.created");
  });

  it("lists event types with includeArchived=true", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created" }, secret));
    await api(jsonRequest("POST", "/v1/event-types", { id: "payment.failed", name: "Payment Failed" }, secret));
    await api(request({ method: "DELETE", path: "/v1/event-types/payment.failed", headers: { authorization: `Bearer ${secret}` } }));

    const res = await api(request({ method: "GET", path: "/v1/event-types", headers: { authorization: `Bearer ${secret}` }, query: { includeArchived: "true" } }));
    expect(res.status).toBe(200);
    expect(body(res).data).toHaveLength(2);
  });

  it("gets a single event type", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created" }, secret));
    const res = await api(request({ method: "GET", path: "/v1/event-types/user.created", headers: { authorization: `Bearer ${secret}` } }));
    expect(res.status).toBe(200);
    expect(body(res).id).toBe("user.created");
  });

  it("returns 404 for unknown event type", async () => {
    const { api, secret } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/event-types/nope", headers: { authorization: `Bearer ${secret}` } }));
    expect(res.status).toBe(404);
  });

  it("updates an event type", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created" }, secret));
    const res = await api(jsonRequest("PATCH", "/v1/event-types/user.created", { name: "User Created (v2)" }, secret));
    expect(res.status).toBe(200);
    expect(body(res).name).toBe("User Created (v2)");
  });

  it("archives an event type (DELETE returns 204)", async () => {
    const { api, secret } = await setup();
    await api(jsonRequest("POST", "/v1/event-types", { id: "user.created", name: "User Created" }, secret));
    const res = await api(request({ method: "DELETE", path: "/v1/event-types/user.created", headers: { authorization: `Bearer ${secret}` } }));
    expect(res.status).toBe(204);
  });

  it("archive returns 204 even for unknown id", async () => {
    const { api, secret } = await setup();
    const res = await api(request({ method: "DELETE", path: "/v1/event-types/nope", headers: { authorization: `Bearer ${secret}` } }));
    expect(res.status).toBe(204);
  });
});

describe("createApi — POST /v1/endpoints/:id/test", () => {
  /** Create an endpoint and return its id + api key. */
  async function makeEndpoint(
    api: ApiHandler,
    key: string,
    url = "https://receiver.example",
  ): Promise<{ id: string }> {
    const res = await api(jsonRequest("POST", "/v1/endpoints", { url }, key));
    return body(res) as { id: string };
  }

  it("returns 200 success when the transport responds 200", async () => {
    const { api, secret } = await setup();
    const ep = await makeEndpoint(api, secret);
    // Inject a transport that always returns 200.
    const transport = vi.fn().mockResolvedValue({ status: 200 });
    const testApi = createApi({
      apps: new InMemoryAppStore(),
      endpoints: new InMemoryEndpointStore(),
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
      transport,
    });
    // Re-create the endpoint under the new api instance.
    const apps2 = new InMemoryAppStore();
    const endpoints2 = new InMemoryEndpointStore();
    const app2 = await apps2.create({ name: "T" });
    const { secret: key2 } = await apps2.createApiKey(app2.id);
    await endpoints2.create({ appId: app2.id, url: "https://recv.example" });
    const ep2 = (await endpoints2.listByApp(app2.id))[0]!;
    const api2 = createApi({
      apps: apps2,
      endpoints: endpoints2,
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
      transport,
    });
    const res = await api2(
      jsonRequest("POST", `/v1/endpoints/${ep2.id}/test`, {}, key2),
    );
    expect(res.status).toBe(200);
    expect(body(res).success).toBe(true);
    expect(body(res).httpStatus).toBe(200);
    expect(typeof body(res).durationMs).toBe("number");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("returns 200 with success:false when the transport responds 500", async () => {
    const apps2 = new InMemoryAppStore();
    const endpoints2 = new InMemoryEndpointStore();
    const app2 = await apps2.create({ name: "T" });
    const { secret: key2 } = await apps2.createApiKey(app2.id);
    await endpoints2.create({ appId: app2.id, url: "https://recv.example" });
    const ep2 = (await endpoints2.listByApp(app2.id))[0]!;
    const transport = vi.fn().mockResolvedValue({ status: 500 });
    const api2 = createApi({
      apps: apps2,
      endpoints: endpoints2,
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
      transport,
    });
    const res = await api2(
      jsonRequest("POST", `/v1/endpoints/${ep2.id}/test`, {}, key2),
    );
    expect(res.status).toBe(200);
    expect(body(res).success).toBe(false);
    expect(body(res).httpStatus).toBe(500);
  });

  it("returns 200 with success:false and error when the transport throws", async () => {
    const apps2 = new InMemoryAppStore();
    const endpoints2 = new InMemoryEndpointStore();
    const app2 = await apps2.create({ name: "T" });
    const { secret: key2 } = await apps2.createApiKey(app2.id);
    await endpoints2.create({ appId: app2.id, url: "https://recv.example" });
    const ep2 = (await endpoints2.listByApp(app2.id))[0]!;
    const transport = vi.fn().mockRejectedValue(new Error("connection refused"));
    const api2 = createApi({
      apps: apps2,
      endpoints: endpoints2,
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
      transport,
    });
    const res = await api2(
      jsonRequest("POST", `/v1/endpoints/${ep2.id}/test`, {}, key2),
    );
    expect(res.status).toBe(200);
    expect(body(res).success).toBe(false);
    expect(body(res).error).toContain("connection refused");
    expect(body(res).httpStatus).toBeUndefined();
  });

  it("uses default test event when body is empty", async () => {
    const apps2 = new InMemoryAppStore();
    const endpoints2 = new InMemoryEndpointStore();
    const app2 = await apps2.create({ name: "T" });
    const { secret: key2 } = await apps2.createApiKey(app2.id);
    await endpoints2.create({ appId: app2.id, url: "https://recv.example", secret: "whsec_testsecret" });
    const ep2 = (await endpoints2.listByApp(app2.id))[0]!;
    let capturedHeaders: Record<string, string> = {};
    const transport = vi.fn().mockImplementation(async (req: HttpDeliveryRequest) => {
      capturedHeaders = req.headers as Record<string, string>;
      return { status: 200 };
    });
    const api2 = createApi({
      apps: apps2,
      endpoints: endpoints2,
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
      transport,
    });
    await api2(request({ method: "POST", path: `/v1/endpoints/${ep2.id}/test`, headers: { authorization: `Bearer ${key2}` } }));
    expect(capturedHeaders["webhook-id"]).toMatch(/^test_/);
    expect(capturedHeaders["webhook-signature"]).toBeDefined();
  });

  it("returns 400 for a disabled endpoint", async () => {
    const apps2 = new InMemoryAppStore();
    const endpoints2 = new InMemoryEndpointStore();
    const app2 = await apps2.create({ name: "T" });
    const { secret: key2 } = await apps2.createApiKey(app2.id);
    await endpoints2.create({ appId: app2.id, url: "https://recv.example" });
    const ep2 = (await endpoints2.listByApp(app2.id))[0]!;
    await endpoints2.update(ep2.id, { disabled: true });
    const api2 = createApi({
      apps: apps2,
      endpoints: endpoints2,
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
    });
    const res = await api2(
      jsonRequest("POST", `/v1/endpoints/${ep2.id}/test`, {}, key2),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("endpoint_disabled");
  });

  it("returns 404 for an unknown or cross-tenant endpoint", async () => {
    const apps2 = new InMemoryAppStore();
    const endpoints2 = new InMemoryEndpointStore();
    const appA = await apps2.create({ name: "A" });
    const appB = await apps2.create({ name: "B" });
    const { secret: keyA } = await apps2.createApiKey(appA.id);
    const { secret: keyB } = await apps2.createApiKey(appB.id);
    await endpoints2.create({ appId: appA.id, url: "https://a.example" });
    const epA = (await endpoints2.listByApp(appA.id))[0]!;
    const api2 = createApi({
      apps: apps2,
      endpoints: endpoints2,
      messages: new InMemoryMessageStore(),
      queue: new InMemoryDeliveryQueue(),
      attempts: new InMemoryDeliveryAttemptStore(),
      eventTypes: new InMemoryEventTypeStore(),
    });
    const missing = await api2(jsonRequest("POST", "/v1/endpoints/nope/test", {}, keyA));
    const crossTenant = await api2(jsonRequest("POST", `/v1/endpoints/${epA.id}/test`, {}, keyB));
    expect(missing.status).toBe(404);
    expect(crossTenant.status).toBe(404);
  });

  it("requires authentication", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "POST", path: "/v1/endpoints/ep_x/test" }));
    expect(res.status).toBe(401);
  });
});

describe("createApi — POST /v1/messages/batch", () => {
  it("accepts a batch and returns one result per message", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "a.created", payload: { n: 1 } },
            { eventType: "b.updated", payload: { n: 2 }, idempotencyKey: "key-1" },
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect(results).toHaveLength(2);
    expect((results[0] as any).ok).toBe(true);
    expect((results[0] as any).message.eventType).toBe("a.created");
    expect((results[0] as any).deduplicated).toBe(false);
    expect((results[1] as any).ok).toBe(true);
    expect((results[1] as any).message.idempotencyKey).toBe("key-1");
  });

  it("returns per-item errors for malformed items without aborting the batch", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "good.event", payload: { ok: true } },
            "not an object", // invalid — not an object
            { eventType: "no.payload" }, // missing payload
            { eventType: "also.good", payload: 42 },
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect(results).toHaveLength(4);
    expect((results[0] as any).ok).toBe(true);
    expect((results[1] as any).ok).toBe(false);
    expect((results[1] as any).error.code).toBe("invalid_request");
    expect((results[2] as any).ok).toBe(false);
    expect((results[2] as any).error.code).toBe("invalid_request");
    expect((results[3] as any).ok).toBe(true);
  });

  it("rejects an empty messages array", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/messages/batch", { messages: [] }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("rejects a messages field that is not an array", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest("POST", "/v1/messages/batch", { messages: "nope" }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("rejects a batch exceeding the 100-item limit", async () => {
    const { api, secret } = await setup();
    const messages = Array.from({ length: 101 }, (_, i) => ({
      eventType: "e",
      payload: { i },
    }));
    const res = await api(
      jsonRequest("POST", "/v1/messages/batch", { messages }, secret),
    );
    expect(res.status).toBe(400);
    expect(body(res).error.code).toBe("invalid_request");
  });

  it("deduplicates idempotent messages within the batch", async () => {
    const { api, secret } = await setup();
    // Send the same idempotency key twice in one batch.
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "e", payload: { n: 1 }, idempotencyKey: "dup" },
            { eventType: "e", payload: { n: 1 }, idempotencyKey: "dup" },
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect((results[0] as any).ok).toBe(true);
    expect((results[0] as any).deduplicated).toBe(false);
    expect((results[1] as any).ok).toBe(true);
    expect((results[1] as any).deduplicated).toBe(true);
    // Both results reference the same message id.
    expect((results[0] as any).message.id).toBe((results[1] as any).message.id);
  });

  it("stops accepting new messages once the monthly quota is reached", async () => {
    let nowMs = Date.UTC(2026, 4, 15, 12, 0, 0);
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, now: () => nowMs, eventTypes });
    const app = await apps.create({ name: "Q", monthlyMessageQuota: 2 });
    const { secret } = await apps.createApiKey(app.id);

    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "e", payload: { n: 1 } },
            { eventType: "e", payload: { n: 2 } },
            { eventType: "e", payload: { n: 3 } }, // over quota
            { eventType: "e", payload: { n: 4 } }, // over quota
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect(results).toHaveLength(4);
    expect((results[0] as any).ok).toBe(true);
    expect((results[1] as any).ok).toBe(true);
    expect((results[2] as any).ok).toBe(false);
    expect((results[2] as any).error.code).toBe("quota_exceeded");
    expect((results[3] as any).ok).toBe(false);
    expect((results[3] as any).error.code).toBe("quota_exceeded");
  });

  it("quota-exempt idempotent replay does not consume the budget", async () => {
    let nowMs = Date.UTC(2026, 4, 15, 12, 0, 0);
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue();
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, now: () => nowMs, eventTypes });
    const app = await apps.create({ name: "Q", monthlyMessageQuota: 1 });
    const { secret } = await apps.createApiKey(app.id);

    // Use up the 1-message quota with a keyed message.
    const first = await api(
      jsonRequest("POST", "/v1/messages", { eventType: "e", payload: { n: 1 }, idempotencyKey: "k1" }, secret),
    );
    expect(first.status).toBe(202);

    // Now send a batch: the replay is exempt; the new message is blocked.
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "e", payload: { n: 1 }, idempotencyKey: "k1" }, // replay — exempt
            { eventType: "e", payload: { n: 2 } }, // new — over quota
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect((results[0] as any).ok).toBe(true);
    expect((results[0] as any).deduplicated).toBe(true);
    expect((results[1] as any).ok).toBe(false);
    expect((results[1] as any).error.code).toBe("quota_exceeded");
  });

  it("requires authentication", async () => {
    const { api } = await setup();
    const res = await api(
      request({ method: "POST", path: "/v1/messages/batch" }),
    );
    expect(res.status).toBe(401);
  });

  it("delays delivery per-item when sendAt is set", async () => {
    let nowMs = 1_700_000_000_000;
    const apps = new InMemoryAppStore();
    const endpoints = new InMemoryEndpointStore();
    const messages = new InMemoryMessageStore({ now: () => nowMs });
    const queue = new InMemoryDeliveryQueue({ now: () => nowMs });
    const attempts = new InMemoryDeliveryAttemptStore();
    const eventTypes = new InMemoryEventTypeStore();
    const api = createApi({ apps, endpoints, messages, queue, attempts, eventTypes, now: () => nowMs });
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://recv.test/h" }, secret));

    // 10s is less than the 30s visibility timeout, so the first claim's lease
    // won't expire before we advance the clock.
    const futureMs = nowMs + 10_000;
    const sendAt = new Date(futureMs).toISOString();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "e", payload: { n: 1 }, sendAt },
            { eventType: "f", payload: { n: 2 } }, // immediate
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect((results[0] as any).ok).toBe(true);
    expect((results[1] as any).ok).toBe(true);

    // At nowMs: only the immediate item is claimable.
    expect(await queue.claimDue({ nowMs })).toHaveLength(1);

    // Past sendAt (still within the first task's lease window): the scheduled item unlocks.
    nowMs = futureMs + 1;
    expect(await queue.claimDue({ nowMs })).toHaveLength(1);
  });

  it("returns a per-item invalid_request for a malformed sendAt in the batch", async () => {
    const { api, secret } = await setup();
    const res = await api(
      jsonRequest(
        "POST",
        "/v1/messages/batch",
        {
          messages: [
            { eventType: "good", payload: {}, sendAt: "not-a-date" },
            { eventType: "also.good", payload: {} },
          ],
        },
        secret,
      ),
    );
    expect(res.status).toBe(200);
    const results = body(res).results as unknown[];
    expect((results[0] as any).ok).toBe(false);
    expect((results[0] as any).error.code).toBe("invalid_request");
    expect((results[1] as any).ok).toBe(true);
  });
});

describe("createApi — GET /v1/deliveries/:id (fetch single delivery)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/deliveries/dtask_1" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown delivery id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/deliveries/dtask_unknown",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(body(res).error.code).toBe("not_found");
  });

  it("returns 404 for another tenant's delivery", async () => {
    const { api, apps, endpoints, messages, queue, attempts } = await setup();
    const eventTypes = new InMemoryEventTypeStore();
    // Tenant B's API talks to the same stores.
    const appB = await apps.create({ name: "B" });
    const bKey = (await apps.createApiKey(appB.id)).secret;
    const apiB = createApi({ apps, endpoints, messages, queue, attempts, eventTypes });

    // Tenant A registers an endpoint and sends a message to create a delivery.
    const { secret: aKey } = await apps.createApiKey((await apps.create({ name: "A" })).id);
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://a.example/hook" }, aKey));
    const msgRes = await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, aKey));
    const msgId: string = body(msgRes).message.id;
    const tasks = await queue.listByMessage(msgId);
    const taskId = tasks[0]!.id;

    // Tenant B cannot see tenant A's delivery.
    const res = await apiB(
      request({
        method: "GET",
        path: `/v1/deliveries/${taskId}`,
        headers: { authorization: `Bearer ${bKey}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns the delivery with status and messageId fields", async () => {
    const { api, secret, queue } = await setup();
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret));
    const msgRes = await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));
    const msgId: string = body(msgRes).message.id;
    const tasks = await queue.listByMessage(msgId);
    const taskId = tasks[0]!.id;

    const res = await api(
      request({
        method: "GET",
        path: `/v1/deliveries/${taskId}`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    const d = body(res) as Record<string, unknown>;
    expect(d["id"]).toBe(taskId);
    expect(d["messageId"]).toBe(msgId);
    expect(d["status"]).toBe("pending");
    expect(d).toHaveProperty("attempts");
    expect(d).toHaveProperty("endpointId");
    expect(d).not.toHaveProperty("leaseToken");
    expect(d).not.toHaveProperty("leaseExpiresAt");
  });
});

describe("createApi — GET /v1/deliveries/:id/attempts (delivery attempt history)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const { api } = await setup();
    const res = await api(request({ method: "GET", path: "/v1/deliveries/dtask_1/attempts" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown delivery id", async () => {
    const { api, secret } = await setup();
    const res = await api(
      request({
        method: "GET",
        path: "/v1/deliveries/dtask_unknown/attempts",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns an empty page when the delivery has no recorded attempts", async () => {
    const { api, secret, queue } = await setup();
    await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret));
    const msgRes = await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));
    const tasks = await queue.listByMessage(body(msgRes).message.id as string);
    const taskId = tasks[0]!.id;

    const res = await api(
      request({
        method: "GET",
        path: `/v1/deliveries/${taskId}/attempts`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual([]);
    expect(body(res).nextCursor).toBeNull();
  });

  it("returns recorded attempts for the delivery, scoped to that task", async () => {
    const { api, secret, queue, attempts, endpoints } = await setup();
    const epRes = await api(jsonRequest("POST", "/v1/endpoints", { url: "https://acme.example/hook" }, secret));
    const epId: string = body(epRes).id;
    const msgRes = await api(jsonRequest("POST", "/v1/messages", { eventType: "e", payload: {} }, secret));
    const msgId: string = body(msgRes).message.id;
    const tasks = await queue.listByMessage(msgId);
    const taskId = tasks[0]!.id;

    // Record an attempt directly on the store.
    await attempts.record({
      taskId,
      messageId: msgId,
      appId: body(epRes).appId as string ?? null,
      endpointId: epId,
      attemptNumber: 1,
      outcome: "failed",
      responseStatus: 503,
      error: "Service Unavailable",
      durationMs: 120,
      attemptedAt: Date.now(),
    });

    const res = await api(
      request({
        method: "GET",
        path: `/v1/deliveries/${taskId}/attempts`,
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
    const data = body(res).data as Record<string, unknown>[];
    expect(data).toHaveLength(1);
    expect(data[0]!["taskId"]).toBe(taskId);
    expect(data[0]!["outcome"]).toBe("failed");
    expect(data[0]!["responseStatus"]).toBe(503);
    expect(body(res).nextCursor).toBeNull();
  });
});
