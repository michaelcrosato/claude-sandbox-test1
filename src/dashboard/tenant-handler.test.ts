import { describe, expect, it } from "vitest";
import { createTenantDashboardHandler } from "./tenant-handler.js";
import { InMemoryTenantSessionStore } from "./tenant-sessions.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryEndpointStore } from "../endpoints/in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { InMemoryDeliveryAttemptStore } from "../attempts/in-memory-attempt-store.js";
import type { ApiRequest } from "../http/api.js";

function setup() {
  const apps = new InMemoryAppStore();
  const endpoints = new InMemoryEndpointStore();
  const messages = new InMemoryMessageStore();
  const queue = new InMemoryDeliveryQueue();
  const attempts = new InMemoryDeliveryAttemptStore();
  const sessions = new InMemoryTenantSessionStore();
  const handler = createTenantDashboardHandler({
    apps,
    endpoints,
    messages,
    queue,
    attempts,
    sessions,
    now: () => 1_000,
  });
  return { apps, endpoints, messages, queue, attempts, sessions, handler };
}

function req(
  method: string,
  path: string,
  opts: { body?: string; cookie?: string; query?: Record<string, string> } = {},
): ApiRequest {
  return {
    method,
    path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    query: opts.query ?? {},
    rawBody: opts.body ?? "",
  };
}

/** Provision an app+key and log in; return the cookie header value. */
async function loginAs(
  handler: ReturnType<typeof createTenantDashboardHandler>,
  apps: InMemoryAppStore,
  name = "TestApp",
): Promise<{ cookie: string; appId: string; secret: string }> {
  const app = await apps.create({ name });
  const { secret } = await apps.createApiKey(app.id);
  const res = await handler(
    req("POST", "/dashboard/tenant/login", {
      body: `apikey=${encodeURIComponent(secret)}`,
    }),
  );
  expect(res.status).toBe(302);
  const setCookie = (res.headers as Record<string, string>)["set-cookie"] as string;
  const match = setCookie.match(/ph_tenant_session=([^;]+)/);
  expect(match).not.toBeNull();
  const cookie = `ph_tenant_session=${match![1]}`;
  return { cookie, appId: app.id, secret };
}

describe("createTenantDashboardHandler — login / logout", () => {
  it("GET /dashboard/tenant/login returns 200 HTML with a login form", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard/tenant/login"));
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(String(res.body)).toContain("apikey");
  });

  it("POST /dashboard/tenant/login with wrong key returns 200 with error", async () => {
    const { handler } = setup();
    const res = await handler(
      req("POST", "/dashboard/tenant/login", { body: "apikey=phk_bogus" }),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("Invalid API key");
  });

  it("POST /dashboard/tenant/login with empty key returns 200 with error", async () => {
    const { handler } = setup();
    const res = await handler(
      req("POST", "/dashboard/tenant/login", { body: "apikey=" }),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("enter your API key");
  });

  it("POST /dashboard/tenant/login with valid key sets HttpOnly SameSite=Strict cookie and redirects", async () => {
    const { handler, apps } = setup();
    const app = await apps.create({ name: "A" });
    const { secret } = await apps.createApiKey(app.id);
    const res = await handler(
      req("POST", "/dashboard/tenant/login", { body: `apikey=${encodeURIComponent(secret)}` }),
    );
    expect(res.status).toBe(302);
    const setCookie = (res.headers as Record<string, string>)["set-cookie"];
    expect(setCookie).toMatch(/ph_tenant_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const location = (res.headers as Record<string, string>)["location"];
    expect(location).toBe("/dashboard/tenant/messages");
  });

  it("POST /dashboard/tenant/logout clears session cookie and redirects to login", async () => {
    const { handler, apps } = setup();
    const { cookie } = await loginAs(handler, apps);
    const res = await handler(req("POST", "/dashboard/tenant/logout", { cookie }));
    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>)["set-cookie"]).toMatch(/Max-Age=0/);
    expect((res.headers as Record<string, string>)["location"]).toBe("/dashboard/tenant/login");
  });
});

describe("createTenantDashboardHandler — auth guard", () => {
  it("GET /dashboard/tenant/messages without session redirects to login", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard/tenant/messages"));
    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>)["location"]).toBe("/dashboard/tenant/login");
  });

  it("GET /dashboard/tenant redirects to messages", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard/tenant"));
    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>)["location"]).toBe("/dashboard/tenant/messages");
  });
});

describe("createTenantDashboardHandler — messages list", () => {
  it("returns 200 HTML with empty state when no messages", async () => {
    const { handler, apps } = setup();
    const { cookie } = await loginAs(handler, apps);
    const res = await handler(req("GET", "/dashboard/tenant/messages", { cookie }));
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("Messages");
    expect(String(res.body)).toContain("No messages yet");
  });

  it("lists own messages and does not leak another tenant's messages", async () => {
    const { handler, apps, messages } = setup();
    const { cookie, appId } = await loginAs(handler, apps, "App1");
    const app2 = await apps.create({ name: "App2" });

    await messages.create({ appId, eventType: "x.y", payload: "1" });
    await messages.create({ appId: app2.id, eventType: "other", payload: "2" });

    const res = await handler(req("GET", "/dashboard/tenant/messages", { cookie }));
    expect(res.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain("x.y");
    expect(body).not.toContain("other");
  });
});

describe("createTenantDashboardHandler — message detail", () => {
  it("returns message detail with deliveries and attempt log", async () => {
    const { handler, apps, messages, endpoints, queue, attempts } = setup();
    const { cookie, appId } = await loginAs(handler, apps);

    const ep = await endpoints.create({ appId, url: "https://example.com/hook" });
    const { message } = await messages.create({ appId, eventType: "user.created", payload: '{"id":1}' });
    const task = await queue.enqueue({ messageId: message.id, endpointId: ep.id });
    await attempts.record({
      taskId: task.id,
      messageId: message.id,
      appId,
      endpointId: ep.id,
      attemptNumber: 1,
      outcome: "succeeded",
      responseStatus: 200,
      durationMs: 42,
      attemptedAt: 1000,
    });

    const res = await handler(
      req("GET", `/dashboard/tenant/messages/${message.id}`, { cookie }),
    );
    expect(res.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain("user.created");
    expect(body).toContain("https://example.com/hook");
    expect(body).toContain("succeeded");
    expect(body).toContain("200");
  });

  it("returns 404 for another tenant's message", async () => {
    const { handler, apps, messages } = setup();
    const { cookie } = await loginAs(handler, apps, "App1");
    const app2 = await apps.create({ name: "App2" });
    const { message } = await messages.create({
      appId: app2.id,
      eventType: "x",
      payload: "{}",
    });
    const res = await handler(
      req("GET", `/dashboard/tenant/messages/${message.id}`, { cookie }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown message id", async () => {
    const { handler, apps } = setup();
    const { cookie } = await loginAs(handler, apps);
    const res = await handler(
      req("GET", "/dashboard/tenant/messages/msg_doesnotexist", { cookie }),
    );
    expect(res.status).toBe(404);
  });
});

describe("createTenantDashboardHandler — endpoints list", () => {
  it("returns 200 HTML with own endpoints only", async () => {
    const { handler, apps, endpoints } = setup();
    const { cookie, appId } = await loginAs(handler, apps, "App1");
    const app2 = await apps.create({ name: "App2" });

    await endpoints.create({ appId, url: "https://my-hook.example/hook" });
    await endpoints.create({ appId: app2.id, url: "https://other.example/hook" });

    const res = await handler(req("GET", "/dashboard/tenant/endpoints", { cookie }));
    expect(res.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain("my-hook.example");
    expect(body).not.toContain("other.example");
  });

  it("returns 200 with empty state when no endpoints", async () => {
    const { handler, apps } = setup();
    const { cookie } = await loginAs(handler, apps);
    const res = await handler(req("GET", "/dashboard/tenant/endpoints", { cookie }));
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("No endpoints");
  });
});

describe("createTenantDashboardHandler — usage bar on messages page", () => {
  it("shows current month message count with no quota", async () => {
    const { handler, apps, messages } = setup();
    const { cookie, appId } = await loginAs(handler, apps, "UsageApp");
    await messages.create({ appId, eventType: "user.created", payload: "{}" });
    await messages.create({ appId, eventType: "order.placed", payload: "{}" });

    const res = await handler(req("GET", "/dashboard/tenant/messages", { cookie }));
    expect(res.status).toBe(200);
    const body = String(res.body);
    // Usage count visible
    expect(body).toContain("2");
    expect(body).toContain("No quota");
  });

  it("shows quota and remaining when app has monthlyMessageQuota", async () => {
    const { handler, apps, messages } = setup();
    const app = await apps.create({ name: "QuotaApp", monthlyMessageQuota: 100 });
    const { secret } = await apps.createApiKey(app.id);
    const loginRes = await handler(
      req("POST", "/dashboard/tenant/login", { body: `apikey=${encodeURIComponent(secret)}` }),
    );
    const setCookie = (loginRes.headers as Record<string, string>)["set-cookie"] as string;
    const match = setCookie.match(/ph_tenant_session=([^;]+)/);
    const cookie = `ph_tenant_session=${match![1]}`;

    await messages.create({ appId: app.id, eventType: "x", payload: "{}" });

    const res = await handler(req("GET", "/dashboard/tenant/messages", { cookie }));
    expect(res.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain("100"); // quota
    expect(body).toContain("99");  // remaining (100 - 1)
  });
});

describe("createTenantDashboardHandler — unknown routes", () => {
  it("returns 404 for an unknown sub-path", async () => {
    const { handler, apps } = setup();
    const { cookie } = await loginAs(handler, apps);
    const res = await handler(req("GET", "/dashboard/tenant/unknown-page", { cookie }));
    expect(res.status).toBe(404);
  });
});
