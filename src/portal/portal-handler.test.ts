import { describe, expect, it } from "vitest";
import { createPortalHandler } from "./portal-handler.js";
import { InMemoryPortalSessionStore } from "./portal-session.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
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

  // ── Unknown routes ────────────────────────────────────────────────────────────

  it("unknown portal route returns 404", async () => {
    const { sessions, handler, clock } = setup();
    const token = sessions.createSession("app_1", "user_42", clock.t);
    const r = withCookie(req({ path: "/portal/totally-unknown" }), COOKIE, token);
    const res = await handler(r);
    expect(res.status).toBe(404);
  });
});
