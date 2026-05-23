import { describe, expect, it } from "vitest";
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
  const api = createApi({ apps, endpoints, messages, queue, attempts });
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
    const api = createApi({ apps, endpoints, messages, queue, attempts });
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
    const api = createApi({ apps, endpoints, messages, queue, attempts, metrics });
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
