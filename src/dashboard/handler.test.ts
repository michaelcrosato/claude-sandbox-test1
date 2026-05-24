import { describe, expect, it } from "vitest";
import { createDashboardHandler } from "./handler.js";
import { InMemorySessionStore } from "./sessions.js";
import { InMemoryAppStore } from "../apps/in-memory-app-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import type { ApiRequest } from "../http/api.js";

const TOKEN = "test-dashboard-token-long-enough";

function setup() {
  const apps = new InMemoryAppStore();
  const sessions = new InMemorySessionStore();
  const handler = createDashboardHandler({
    apps,
    sessions,
    adminToken: TOKEN,
    now: () => 1_000,
  });
  return { apps, sessions, handler };
}

function setupWithMessages() {
  const apps = new InMemoryAppStore();
  const sessions = new InMemorySessionStore();
  // Use a fixed clock in the middle of 2025-01 so utcMonthRange covers Jan 2025.
  const now = () => new Date("2025-01-15T12:00:00Z").getTime();
  const messages = new InMemoryMessageStore({ now });
  const handler = createDashboardHandler({
    apps,
    sessions,
    adminToken: TOKEN,
    messages,
    now,
  });
  return { apps, sessions, messages, handler, now };
}

function req(
  method: string,
  path: string,
  opts: { body?: string; cookie?: string } = {},
): ApiRequest {
  return {
    method,
    path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    query: {},
    rawBody: opts.body ?? "",
  };
}

/** Login with the correct token and return the session cookie value. */
async function login(handler: ReturnType<typeof createDashboardHandler>): Promise<string> {
  const res = await handler(
    req("POST", "/dashboard/login", { body: `token=${encodeURIComponent(TOKEN)}` }),
  );
  const setCookie = (res.headers as Record<string, string>)["set-cookie"] as string;
  return setCookie;
}

/** Make an authenticated request. */
async function authed(
  handler: ReturnType<typeof createDashboardHandler>,
  method: string,
  path: string,
  opts: { body?: string } = {},
) {
  const cookieHeader = await login(handler);
  const match = cookieHeader.match(/ph_session=([^;]+)/);
  const cookie = `ph_session=${match![1]}`;
  return handler(req(method, path, { ...opts, cookie }));
}

describe("createDashboardHandler — login / logout", () => {
  it("GET /dashboard/login returns the login page", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard/login"));
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(String(res.body)).toContain("Sign in");
  });

  it("POST /dashboard/login with wrong token returns 200 with error", async () => {
    const { handler } = setup();
    const res = await handler(
      req("POST", "/dashboard/login", { body: "token=wrong-token" }),
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("Invalid admin token");
  });

  it("POST /dashboard/login with correct token sets session cookie and redirects", async () => {
    const { handler } = setup();
    const res = await handler(
      req("POST", "/dashboard/login", { body: `token=${encodeURIComponent(TOKEN)}` }),
    );
    expect(res.status).toBe(302);
    const headers = res.headers as Record<string, string>;
    expect(headers["location"]).toBe("/dashboard/apps");
    expect(headers["set-cookie"]).toMatch(/ph_session=[^;]+/);
    expect(headers["set-cookie"]).toContain("HttpOnly");
    expect(headers["set-cookie"]).toContain("SameSite=Strict");
  });

  it("POST /dashboard/logout clears cookie and redirects to login", async () => {
    const { handler } = setup();
    const cookieValue = await login(handler);
    const sessionToken = cookieValue.match(/ph_session=([^;]+)/)![1];
    const res = await handler(req("POST", "/dashboard/logout", { cookie: `ph_session=${sessionToken}` }));
    expect(res.status).toBe(302);
    const headers = res.headers as Record<string, string>;
    expect(headers["location"]).toBe("/dashboard/login");
    expect(headers["set-cookie"]).toContain("Max-Age=0");
  });
});

describe("createDashboardHandler — auth guard", () => {
  it("GET /dashboard redirects to /dashboard/apps via login when unauthenticated", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard"));
    // /dashboard → redirect to /dashboard/apps (no auth check on the top redirect)
    expect(res.status).toBe(302);
    const headers = res.headers as Record<string, string>;
    expect(headers["location"]).toBe("/dashboard/apps");
  });

  it("GET /dashboard/apps unauthenticated redirects to login", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard/apps"));
    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>)["location"]).toBe("/dashboard/login");
  });

  it("GET /dashboard/apps authenticated returns the apps page", async () => {
    const { handler } = setup();
    const res = await authed(handler, "GET", "/dashboard/apps");
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("Apps");
  });
});

describe("createDashboardHandler — apps CRUD", () => {
  it("POST /dashboard/apps creates an app and redirects to its detail page", async () => {
    const { handler, apps } = setup();
    const res = await authed(handler, "POST", "/dashboard/apps", {
      body: "name=Test+App",
    });
    expect(res.status).toBe(302);
    const all = await apps.list();
    expect(all).toHaveLength(1);
    const headers = res.headers as Record<string, string>;
    expect(headers["location"]).toBe(`/dashboard/apps/${all[0]!.id}`);
  });

  it("POST /dashboard/apps with quota creates an app with the specified quota", async () => {
    const { handler, apps } = setup();
    await authed(handler, "POST", "/dashboard/apps", {
      body: "name=Quota+App&quota=5000",
    });
    const all = await apps.list();
    expect(all[0]!.monthlyMessageQuota).toBe(5000);
  });

  it("GET /dashboard/apps/:id returns the app detail page", async () => {
    const { handler, apps } = setup();
    const app = await apps.create({ name: "My App" });
    const res = await authed(handler, "GET", `/dashboard/apps/${app.id}`);
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("My App");
    expect(String(res.body)).toContain(app.id);
  });

  it("GET /dashboard/apps/:id for unknown app returns 404", async () => {
    const { handler } = setup();
    const res = await authed(handler, "GET", "/dashboard/apps/app_ghost");
    expect(res.status).toBe(404);
  });

  it("POST /dashboard/apps/:id/delete deletes the app and redirects to /dashboard/apps", async () => {
    const { handler, apps } = setup();
    const app = await apps.create({ name: "Doomed" });
    const res = await authed(handler, "POST", `/dashboard/apps/${app.id}/delete`);
    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>)["location"]).toBe("/dashboard/apps");
    expect(await apps.get(app.id)).toBeNull();
  });
});

describe("createDashboardHandler — API key management", () => {
  it("POST /dashboard/apps/:id/keys creates a key and shows the secret once", async () => {
    const { handler, apps } = setup();
    const app = await apps.create({ name: "Keyed" });
    const res = await authed(handler, "POST", `/dashboard/apps/${app.id}/keys`);
    expect(res.status).toBe(200);
    const html = String(res.body);
    // The response page contains the one-time-secret banner
    expect(html).toContain("New API key created");
    // The secret itself (phk_ prefix) is in the response
    expect(html).toContain("phk_");
    // The key is persisted
    const keys = await apps.listApiKeys(app.id);
    expect(keys).toHaveLength(1);
  });

  it("POST /dashboard/apps/:id/keys/:keyId/revoke revokes the key and redirects", async () => {
    const { handler, apps } = setup();
    const app = await apps.create({ name: "App" });
    const { apiKey } = await apps.createApiKey(app.id);
    const res = await authed(
      handler,
      "POST",
      `/dashboard/apps/${app.id}/keys/${apiKey.id}/revoke`,
    );
    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>)["location"]).toBe(
      `/dashboard/apps/${app.id}`,
    );
    const keys = await apps.listApiKeys(app.id);
    expect(keys[0]!.revokedAt).not.toBeNull();
  });
});

describe("createDashboardHandler — unknown routes", () => {
  it("returns 404 for an unrecognised path", async () => {
    const { handler } = setup();
    const res = await handler(req("GET", "/dashboard/nonexistent"));
    expect(res.status).toBe(404);
  });
});

describe("createDashboardHandler — per-app usage column", () => {
  it("apps list without messages store shows '—' in usage column", async () => {
    const { handler, apps } = setup();
    await apps.create({ name: "Alpha" });
    const res = await authed(handler, "GET", "/dashboard/apps");
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("This-month usage");
    expect(html).toContain("—");
  });

  it("apps list with messages store and no traffic shows 0 for each app", async () => {
    const { handler, apps } = setupWithMessages();
    await apps.create({ name: "Beta" });
    const res = await authed(handler, "GET", "/dashboard/apps");
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("This-month usage");
    expect(String(res.body)).toContain(">0<");
  });

  it("apps list with messages store shows correct per-app message count", async () => {
    const { handler, apps, messages } = setupWithMessages();
    const app = await apps.create({ name: "Gamma" });
    const other = await apps.create({ name: "Delta" });
    // Seed 3 messages for Gamma, 1 for Delta — all within January 2025.
    for (let i = 0; i < 3; i++) {
      await messages.create({ appId: app.id, eventType: "test", payload: "{}" });
    }
    await messages.create({ appId: other.id, eventType: "test", payload: "{}" });
    const res = await authed(handler, "GET", "/dashboard/apps");
    expect(res.status).toBe(200);
    const body = String(res.body);
    // Gamma row has 3, Delta row has 1
    expect(body).toContain(">3<");
    expect(body).toContain(">1<");
  });
});
