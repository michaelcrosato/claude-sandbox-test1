import { describe, it, expect } from "vitest";
import { InMemoryTenantSessionStore, TENANT_SESSION_TTL_MS } from "./tenant-sessions.js";

describe("InMemoryTenantSessionStore", () => {
  it("createSession returns a non-empty token", () => {
    const store = new InMemoryTenantSessionStore();
    const token = store.createSession("app_1", 0);
    expect(token.length).toBeGreaterThan(0);
  });

  it("validateSession returns appId for a live session", () => {
    const store = new InMemoryTenantSessionStore();
    const token = store.createSession("app_abc", 1000);
    expect(store.validateSession(token, 1000)).toBe("app_abc");
  });

  it("validateSession returns null for an unknown token", () => {
    const store = new InMemoryTenantSessionStore();
    expect(store.validateSession("no-such-token", 0)).toBeNull();
  });

  it("validateSession returns null and prunes an expired session", () => {
    const store = new InMemoryTenantSessionStore();
    const token = store.createSession("app_1", 0);
    // Exactly at expiry → expired (expiresAt = TTL, now >= expiresAt)
    expect(store.validateSession(token, TENANT_SESSION_TTL_MS)).toBeNull();
    // Verify it was pruned: a second call still returns null
    expect(store.validateSession(token, 0)).toBeNull();
  });

  it("deleteSession causes subsequent validateSession to return null", () => {
    const store = new InMemoryTenantSessionStore();
    const token = store.createSession("app_1", 0);
    expect(store.validateSession(token, 0)).toBe("app_1");
    store.deleteSession(token);
    expect(store.validateSession(token, 0)).toBeNull();
  });

  it("deleteSession is a no-op for an unknown token", () => {
    const store = new InMemoryTenantSessionStore();
    expect(() => store.deleteSession("ghost")).not.toThrow();
  });

  it("two sessions can coexist with different appIds", () => {
    const store = new InMemoryTenantSessionStore();
    const t1 = store.createSession("app_1", 0);
    const t2 = store.createSession("app_2", 0);
    expect(store.validateSession(t1, 0)).toBe("app_1");
    expect(store.validateSession(t2, 0)).toBe("app_2");
  });
});
