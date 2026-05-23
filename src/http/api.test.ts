import { describe, expect, it } from "vitest";
import { createApi, type ApiHandler, type ApiRequest, type ApiResponse } from "./api.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { DeliveryWorker, type HttpDeliveryRequest } from "../worker/delivery-worker.js";
import { storeBackedResolver } from "../endpoints/endpoint-resolver.js";
import { verify } from "../signing/webhook-signature.js";

interface Fixture {
  readonly apps: InMemoryAppStore;
  readonly endpoints: InMemoryEndpointStore;
  readonly messages: InMemoryMessageStore;
  readonly queue: InMemoryDeliveryQueue;
  readonly api: ApiHandler;
  readonly appId: string;
  readonly secret: string;
}

async function setup(): Promise<Fixture> {
  const apps = new InMemoryAppStore();
  const endpoints = new InMemoryEndpointStore();
  const messages = new InMemoryMessageStore();
  const queue = new InMemoryDeliveryQueue();
  const api = createApi({ apps, endpoints, messages, queue });
  const app = await apps.create({ name: "Acme" });
  const { secret } = await apps.createApiKey(app.id);
  return { apps, endpoints, messages, queue, api, appId: app.id, secret };
}

/** Build a request, defaulting the unset fields. */
function request(partial: Partial<ApiRequest>): ApiRequest {
  return { method: "GET", path: "/", headers: {}, rawBody: "", ...partial };
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
    expect(aGet.status).toBe(404);
    expect(aPatch.status).toBe(404);
    expect(aDelete.status).toBe(404);

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
