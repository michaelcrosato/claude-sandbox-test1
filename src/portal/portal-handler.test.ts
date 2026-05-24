import { describe, expect, it } from "vitest";
import { createPortalHandler } from "./portal-handler.js";
import { InMemoryPortalSessionStore } from "./portal-session.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { fixedSchedule } from "../delivery/retry-policy.js";
import { sign } from "../signing/webhook-signature.js";
import type { ApiRequest } from "../http/api.js";

function req(partial: Partial<ApiRequest>): ApiRequest {
  return { method: "GET", path: "/", headers: {}, query: {}, rawBody: "", ...partial };
}

function withCookie(r: ApiRequest, name: string, value: string): ApiRequest {
  return { ...r, headers: { ...r.headers, cookie: `${name}=${value}` } };
}

const COOKIE = "ph_portal_session";

/** Set up a handler with default in-memory stores. */
function setup(nowMs = 1_000_000) {
  const endpoints = new InMemoryEndpointStore();
  const queue = new InMemoryDeliveryQueue();
  const sessions = new InMemoryPortalSessionStore();
  const clock = { t: nowMs };
  const handler = createPortalHandler({
    endpoints,
    queue,
    sessions,
    now: () => clock.t,
  });
  return { endpoints, queue, sessions, handler, clock };
}

describe("createPortalHandler", () => {
  // ── Token exchange ────────────────────────────────────────────────────────────

  it("GET /portal/login with no token returns 200 expired page", async () => {
    const { handler } = setup();
    const res = await handler(req({ path: "/portal/login" }));
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/html/);
    expect(String(res.body)).toMatch(/expired|invalid/i);
  });

  it("GET /portal/login with unknown token returns 200 expired page", async () => {
    const { handler } = setup();
    const res = await handler(req({ path: "/portal/login", query: { token: "bad-token" } }));
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/expired|invalid/i);
  });

  it("GET /portal/login with valid token sets cookie and redirects", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const res = await handler(req({ path: "/portal/login", query: { token } }));
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/endpoints");
    expect(res.headers?.["set-cookie"]).toContain(token);
    expect(res.headers?.["set-cookie"]).toContain("HttpOnly");
    expect(res.headers?.["set-cookie"]).toContain("SameSite=Strict");
  });

  // ── Auth guard ────────────────────────────────────────────────────────────────

  it("GET /portal/endpoints with no cookie redirects to /portal/login", async () => {
    const { handler } = setup();
    const res = await handler(req({ path: "/portal/endpoints" }));
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/login");
  });

  it("GET /portal/endpoints with expired session redirects to /portal/login", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t, 500);
    clock.t += 600; // past expiry
    const r = withCookie(req({ path: "/portal/endpoints" }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/login");
  });

  // ── Endpoints list ────────────────────────────────────────────────────────────

  it("GET /portal/endpoints with valid session returns 200 with endpoints", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const r = withCookie(req({ path: "/portal/endpoints" }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("recv.example/a");
  });

  it("GET /portal shows redirect to /portal/endpoints when authed", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const r = withCookie(req({ path: "/portal" }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/endpoints");
  });

  // ── Endpoint CRUD ─────────────────────────────────────────────────────────────

  it("POST /portal/endpoints creates an endpoint and shows secret banner", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const r = withCookie(
      req({
        method: "POST",
        path: "/portal/endpoints",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        rawBody: "url=https%3A%2F%2Frecv.example%2Fhook",
      }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("recv.example/hook");
    // Secret banner must be present (the whsec_ prefix).
    expect(html).toContain("whsec_");
  });

  it("GET /portal/endpoints/:id returns endpoint detail", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const r = withCookie(req({ path: `/portal/endpoints/${ep.id}` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("recv.example/a");
  });

  it("GET /portal/endpoints/:id of another tenant's endpoint returns 404", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_2", url: "https://other.example/hook" });
    const r = withCookie(req({ path: `/portal/endpoints/${ep.id}` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(404);
  });

  it("POST /portal/endpoints/:id/delete removes the endpoint and redirects", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/delete` }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/endpoints");
    expect(await endpoints.get(ep.id)).toBeNull();
  });

  it("POST /portal/endpoints/:id/rotate-secret shows the new secret once", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const originalSecret = ep.secret;
    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/rotate-secret` }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("whsec_");
    const rotated = await endpoints.get(ep.id);
    expect(rotated!.secret).not.toBe(originalSecret);
  });

  // ── Logout ────────────────────────────────────────────────────────────────────

  it("POST /portal/logout clears the session cookie and redirects", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const r = withCookie(req({ method: "POST", path: "/portal/logout" }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/login");
    expect(res.headers?.["set-cookie"]).toContain("Max-Age=0");
    // Session is gone: the token no longer validates.
    expect(sessions.getSession(token, clock.t + 1)).toBeNull();
  });

  // ── Delivery detail ───────────────────────────────────────────────────────────

  it("GET /portal/endpoints/:id/deliveries/:deliveryId returns 200 with delivery info", async () => {
    const { endpoints, queue, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const task = await queue.enqueue({ messageId: "msg_123", endpointId: ep.id, appId: "app_1" });
    const r = withCookie(req({ path: `/portal/endpoints/${ep.id}/deliveries/${task.id}` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("msg_123");
    expect(html).toContain("pending");
  });

  it("GET delivery detail shows ?retried=1 success banner", async () => {
    const { endpoints, queue, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const task = await queue.enqueue({ messageId: "msg_123", endpointId: ep.id, appId: "app_1" });
    const r = withCookie(
      req({ path: `/portal/endpoints/${ep.id}/deliveries/${task.id}`, query: { retried: "1" } }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/retry|queued/i);
  });

  it("GET delivery detail returns 404 for unknown delivery id", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const r = withCookie(req({ path: `/portal/endpoints/${ep.id}/deliveries/dtask_nonexistent` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(404);
  });

  it("GET delivery detail returns 404 when delivery belongs to a different endpoint", async () => {
    const { endpoints, queue, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep1 = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const ep2 = await endpoints.create({ appId: "app_1", url: "https://recv.example/b" });
    const task = await queue.enqueue({ messageId: "msg_1", endpointId: ep2.id, appId: "app_1" });
    // Request delivery via ep1's URL but the task belongs to ep2
    const r = withCookie(req({ path: `/portal/endpoints/${ep1.id}/deliveries/${task.id}` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(404);
  });

  it("GET delivery detail returns 404 for a cross-tenant endpoint", async () => {
    const { endpoints, queue, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_2", url: "https://other.example/hook" });
    const task = await queue.enqueue({ messageId: "msg_1", endpointId: ep.id, appId: "app_2" });
    const r = withCookie(req({ path: `/portal/endpoints/${ep.id}/deliveries/${task.id}` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(404);
  });

  it("GET delivery detail shows Retry button only for dead_letter status", async () => {
    const endpoints = new InMemoryEndpointStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const sessions = new InMemoryPortalSessionStore();
    const clock = { t: 1_000_000 };
    const handler = createPortalHandler({ endpoints, queue, sessions, now: () => clock.t });

    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const task = await queue.enqueue({ messageId: "msg_1", endpointId: ep.id, appId: "app_1" });
    const claims = await queue.claimDue({ nowMs: clock.t });
    const claimed = claims[0] as NonNullable<(typeof claims)[number]>;
    await queue.fail(claimed.id, claimed.leaseToken!, { error: "timeout", nowMs: clock.t });

    const r = withCookie(req({ path: `/portal/endpoints/${ep.id}/deliveries/${task.id}` }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("dead letter");
    expect(html).toContain("Retry delivery");
  });

  // ── Delivery retry ────────────────────────────────────────────────────────────

  it("POST /portal/endpoints/:id/deliveries/:deliveryId/retry re-queues a dead-lettered delivery", async () => {
    const endpoints = new InMemoryEndpointStore();
    const queue = new InMemoryDeliveryQueue({ retryPolicy: fixedSchedule([]) });
    const sessions = new InMemoryPortalSessionStore();
    const clock = { t: 1_000_000 };
    const handler = createPortalHandler({ endpoints, queue, sessions, now: () => clock.t });

    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const task = await queue.enqueue({ messageId: "msg_1", endpointId: ep.id, appId: "app_1" });
    const claims2 = await queue.claimDue({ nowMs: clock.t });
    const claimed2 = claims2[0] as NonNullable<(typeof claims2)[number]>;
    await queue.fail(claimed2.id, claimed2.leaseToken!, { error: "boom", nowMs: clock.t });

    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/deliveries/${task.id}/retry` }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe(`/portal/endpoints/${ep.id}/deliveries/${task.id}?retried=1`);
    const revived = await queue.get(task.id);
    expect(revived?.status).toBe("pending");
  });

  it("POST retry on a non-terminal delivery redirects to detail without ?retried", async () => {
    const { endpoints, queue, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const task = await queue.enqueue({ messageId: "msg_1", endpointId: ep.id, appId: "app_1" });
    // Task is pending (non-terminal) — retry should be rejected gracefully
    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/deliveries/${task.id}/retry` }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe(`/portal/endpoints/${ep.id}/deliveries/${task.id}`);
  });

  it("POST retry returns 404 for unknown delivery", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/deliveries/dtask_nope/retry` }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(404);
  });

  // ── Signature verification widget ─────────────────────────────────────────────

  it("POST /portal/endpoints/:id/verify unauthenticated redirects to login", async () => {
    const { endpoints, handler, clock } = setup();
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const r = req({ method: "POST", path: `/portal/endpoints/${ep.id}/verify`, rawBody: "" });
    const res = await handler(r);
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/login");
  });

  it("POST /portal/endpoints/:id/verify for cross-tenant endpoint returns 404", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_2", url: "https://other.example/hook" });
    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/verify`, rawBody: "" }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(404);
  });

  it("POST /portal/endpoints/:id/verify with valid signature shows success", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });

    const msgId = "msg_verify_test";
    const timestamp = Math.floor(clock.t / 1000);
    const body = '{"eventType":"test","data":{}}';
    const signature = sign(ep.secret, { id: msgId, timestamp, payload: body });

    const formBody = new URLSearchParams({
      webhookId: msgId,
      webhookTimestamp: String(timestamp),
      webhookSignature: signature,
      rawBody: body,
    }).toString();

    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/verify`, rawBody: formBody }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/verified|authentic/i);
    // Form values echoed back for state preservation
    expect(String(res.body)).toContain(msgId);
  });

  it("POST /portal/endpoints/:id/verify with wrong signature shows failure", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });

    const formBody = new URLSearchParams({
      webhookId: "msg_1",
      webhookTimestamp: String(Math.floor(clock.t / 1000)),
      webhookSignature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      rawBody: '{"data":1}',
    }).toString();

    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/verify`, rawBody: formBody }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/failed|no matching/i);
  });

  it("POST /portal/endpoints/:id/verify with missing headers shows error", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });

    const formBody = new URLSearchParams({ webhookId: "", webhookTimestamp: "", webhookSignature: "", rawBody: "" }).toString();
    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/verify`, rawBody: formBody }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/required/i);
  });

  it("POST /portal/endpoints/:id/verify succeeds against a rotated (previous) secret", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const ep = await endpoints.create({ appId: "app_1", url: "https://recv.example/a" });
    const oldSecret = ep.secret;

    // Rotate to a new secret — old one stays active for 24h overlap
    await endpoints.rotateSecret(ep.id);

    const msgId = "msg_old_secret";
    const timestamp = Math.floor(clock.t / 1000);
    const body = '{"eventType":"test"}';
    // Sign with the OLD secret (simulates a webhook that arrived before rotation propagated)
    const signature = sign(oldSecret, { id: msgId, timestamp, payload: body });

    const formBody = new URLSearchParams({
      webhookId: msgId,
      webhookTimestamp: String(timestamp),
      webhookSignature: signature,
      rawBody: body,
    }).toString();

    const r = withCookie(
      req({ method: "POST", path: `/portal/endpoints/${ep.id}/verify`, rawBody: formBody }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/verified|authentic/i);
  });

  // ── Unknown routes ────────────────────────────────────────────────────────────

  it("unknown portal route returns 404", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const r = withCookie(req({ path: "/portal/totally-unknown" }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(404);
  });
});
