import { describe, expect, it } from "vitest";
import { createPortalHandler } from "./portal-handler.js";
import { InMemoryPortalSessionStore } from "./portal-session.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { InMemoryEventTypeStore } from "../event-types/in-memory-event-type-store.js";
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

  it("POST /portal/endpoints rejects a private/internal URL (SSRF guard) and does not create it", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const r = withCookie(
      req({
        method: "POST",
        path: "/portal/endpoints",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        rawBody: "url=http%3A%2F%2Flocalhost%3A6379%2F", // http://localhost:6379/
      }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("private or internal address"); // inline error surfaced
    expect(html).not.toContain("whsec_"); // no secret banner — nothing was created
    expect(await endpoints.listByApp("app_1")).toHaveLength(0);
  });

  it("POST /portal/endpoints does not reflect a malformed URL as executable script (XSS guard)", async () => {
    const { endpoints, sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    // A URL that fails to parse falls through to the endpoint store's syntactic
    // validation, whose error echoes the raw input verbatim. The closing-tag
    // payload must never break out of the page into an executable <script>.
    const payload = "abc</script><script>alert(document.cookie)</script>";
    const r = withCookie(
      req({
        method: "POST",
        path: "/portal/endpoints",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        rawBody: `url=${encodeURIComponent(payload)}`,
      }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    const html = String(res.body);
    // No script breakout: neither the closing-tag boundary nor the injected
    // script survives unescaped (the previous inline <script>alert(JSON.stringify
    // (...))> sink did not neutralize a `</script>`).
    expect(html).not.toContain("</script><script>");
    expect(html).not.toContain("<script>alert(document.cookie)</script>");
    // The error IS surfaced — HTML-escaped — in the inline banner.
    expect(html).toContain("alert-err");
    expect(html).toContain("&lt;/script&gt;");
    // And nothing was created from the bad input.
    expect(await endpoints.listByApp("app_1")).toHaveLength(0);
  });

  it("POST /portal/endpoints permits an internal URL when allowPrivateNetworks is set", async () => {
    const endpoints = new InMemoryEndpointStore();
    const queue = new InMemoryDeliveryQueue();
    const sessions = new InMemoryPortalSessionStore();
    const now = 1_000_000;
    const handler = createPortalHandler({
      endpoints,
      queue,
      sessions,
      now: () => now,
      allowPrivateNetworks: true,
    });
    const token = sessions.createSession("app_1", "user_42", now);
    const r = withCookie(
      req({
        method: "POST",
        path: "/portal/endpoints",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        rawBody: "url=http%3A%2F%2F127.0.0.1%3A8080%2Fhook",
      }),
      COOKIE,
      token,
    );
    const res = await handler(r);
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("whsec_"); // created, secret shown
    expect(await endpoints.listByApp("app_1")).toHaveLength(1);
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

  // ── Rate limit field ──────────────────────────────────────────────────────────

  it("POST /portal/endpoints creates an endpoint with a rate limit and detail page shows it", async () => {
    const { sessions, endpoints, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    const body = new URLSearchParams({ url: "https://example.com/hook", rateLimit: "60" }).toString();
    const res = await handler(
      withCookie(req({ method: "POST", path: "/portal/endpoints", rawBody: body }), COOKIE, token),
    );
    expect(res.status).toBe(200);
    const list = await endpoints.listByApp("app_1");
    expect(list).toHaveLength(1);
    expect(list[0]!.rateLimit).toBe(60);
    // Detail page shows the rate limit
    const detail = await handler(
      withCookie(req({ path: `/portal/endpoints/${list[0]!.id}` }), COOKIE, token),
    );
    expect(String(detail.body)).toContain("60");
  });

  it("POST /portal/endpoints/:id/update clears the rate limit when field is empty", async () => {
    const { sessions, endpoints, handler, clock } = setup();
    const ep = await endpoints.create({ appId: "app_2", url: "https://example.com/hook", rateLimit: 100 });
    const token = sessions.createSession("app_2", "user_2", clock.t);
    const body = new URLSearchParams({ url: ep.url, rateLimit: "" }).toString();
    const res = await handler(
      withCookie(req({ method: "POST", path: `/portal/endpoints/${ep.id}/update`, rawBody: body }), COOKIE, token),
    );
    expect(res.status).toBe(200);
    const updated = await endpoints.get(ep.id);
    expect(updated!.rateLimit).toBeNull();
    // Detail page shows "No limit"
    expect(String(res.body)).toContain("No limit");
  });

  // ── Event type catalog management ─────────────────────────────────────────────

  function setupWithEventTypes(nowMs = 1_000_000) {
    const endpoints = new InMemoryEndpointStore();
    const queue = new InMemoryDeliveryQueue();
    const sessions = new InMemoryPortalSessionStore();
    const eventTypes = new InMemoryEventTypeStore({ now: () => clock.t });
    const clock = { t: nowMs };
    const handler = createPortalHandler({
      endpoints,
      queue,
      sessions,
      eventTypes,
      now: () => clock.t,
    });
    return { endpoints, queue, sessions, eventTypes, handler, clock };
  }

  it("GET /portal/event-types without event-type store returns 404", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    const res = await handler(
      withCookie(req({ path: "/portal/event-types" }), COOKIE, token),
    );
    expect(res.status).toBe(404);
  });

  it("GET /portal/event-types unauthenticated redirects to login", async () => {
    const { handler } = setupWithEventTypes();
    const res = await handler(req({ path: "/portal/event-types" }));
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/login");
  });

  it("GET /portal/event-types with valid session returns 200 with event type list", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_1", id: "user.created", name: "User created" });
    const res = await handler(
      withCookie(req({ path: "/portal/event-types" }), COOKIE, token),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("user.created");
    expect(String(res.body)).toContain("User created");
  });

  it("POST /portal/event-types creates an event type and shows confirmation", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    const body = new URLSearchParams({ id: "order.shipped", name: "Order shipped" }).toString();
    const res = await handler(
      withCookie(
        req({ method: "POST", path: "/portal/event-types", rawBody: body }),
        COOKIE,
        token,
      ),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("order.shipped");
    const list = await eventTypes.list("app_1");
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("order.shipped");
  });

  it("POST /portal/event-types with invalid id shows error banner", async () => {
    const { sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    const body = new URLSearchParams({ id: "!!bad id!!", name: "Bad" }).toString();
    const res = await handler(
      withCookie(
        req({ method: "POST", path: "/portal/event-types", rawBody: body }),
        COOKIE,
        token,
      ),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toMatch(/alert-err|error/i);
  });

  it("GET /portal/event-types/:id returns detail page", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_1", id: "user.created", name: "User created", description: "When a user signs up" });
    const res = await handler(
      withCookie(req({ path: "/portal/event-types/user.created" }), COOKIE, token),
    );
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("user.created");
    expect(html).toContain("When a user signs up");
  });

  it("GET /portal/event-types/:id for unknown id returns 404", async () => {
    const { sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    const res = await handler(
      withCookie(req({ path: "/portal/event-types/no.such.type" }), COOKIE, token),
    );
    expect(res.status).toBe(404);
  });

  it("GET /portal/event-types/:id for a different tenant's type returns 404", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_2", id: "other.event", name: "Other" });
    const res = await handler(
      withCookie(req({ path: "/portal/event-types/other.event" }), COOKIE, token),
    );
    expect(res.status).toBe(404);
  });

  it("POST /portal/event-types/:id/update saves changes and shows saved banner", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_1", id: "user.created", name: "User created" });
    const body = new URLSearchParams({ name: "User registered", description: "New description" }).toString();
    const res = await handler(
      withCookie(
        req({ method: "POST", path: "/portal/event-types/user.created/update", rawBody: body }),
        COOKIE,
        token,
      ),
    );
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("User registered");
    expect(html).toContain("New description");
    expect(html).toMatch(/saved|changes/i);
    const et = await eventTypes.get("app_1", "user.created");
    expect(et!.name).toBe("User registered");
  });

  it("POST /portal/event-types/:id/archive archives and redirects to list", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_1", id: "user.created", name: "User created" });
    const res = await handler(
      withCookie(
        req({ method: "POST", path: "/portal/event-types/user.created/archive" }),
        COOKIE,
        token,
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers?.["location"]).toBe("/portal/event-types");
    const et = await eventTypes.get("app_1", "user.created");
    expect(et!.archived).toBe(true);
  });

  it("GET /portal/event-types/:id shows no subscribers when no endpoints are subscribed", async () => {
    const { eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_1", id: "user.created", name: "User created" });
    const res = await handler(
      withCookie(req({ path: "/portal/event-types/user.created" }), COOKIE, token),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("No endpoints");
  });

  it("GET /portal/event-types/:id shows endpoints subscribed to that type", async () => {
    const { endpoints, eventTypes, sessions, handler, clock } = setupWithEventTypes();
    const token = sessions.createSession("app_1", "user_1", clock.t);
    await eventTypes.create({ appId: "app_1", id: "order.placed", name: "Order placed" });
    await endpoints.create({ appId: "app_1", url: "https://example.com/hook", eventTypes: ["order.placed"] });
    await endpoints.create({ appId: "app_1", url: "https://other.com/hook", eventTypes: ["user.created"] });
    const res = await handler(
      withCookie(req({ path: "/portal/event-types/order.placed" }), COOKIE, token),
    );
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("https://example.com/hook");
    expect(html).not.toContain("https://other.com/hook");
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
