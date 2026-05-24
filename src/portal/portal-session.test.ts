import { describe, expect, it } from "vitest";
import {
  InMemoryPortalSessionStore,
  DEFAULT_PORTAL_SESSION_TTL_MS,
  MAX_PORTAL_SESSION_TTL_MS,
} from "./portal-session.js";

describe("InMemoryPortalSessionStore", () => {
  it("createSession returns a non-empty string token", () => {
    const store = new InMemoryPortalSessionStore();
    const token = store.createSession("app_1", "user_42", 1_000);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("getSession returns the session before expiry", () => {
    const store = new InMemoryPortalSessionStore();
    const now = 1_000;
    const token = store.createSession("app_1", "user_42", now);
    const session = store.getSession(token, now + 1);
    expect(session).not.toBeNull();
    expect(session!.appId).toBe("app_1");
    expect(session!.externalUserId).toBe("user_42");
    expect(session!.createdAt).toBe(now);
    expect(session!.expiresAt).toBe(now + DEFAULT_PORTAL_SESSION_TTL_MS);
  });

  it("getSession returns null for an unknown token", () => {
    const store = new InMemoryPortalSessionStore();
    expect(store.getSession("does-not-exist", 1_000)).toBeNull();
  });

  it("getSession returns null and prunes an expired session", () => {
    const store = new InMemoryPortalSessionStore();
    const now = 1_000;
    const token = store.createSession("app_1", "user_42", now, 500);
    // Not yet expired.
    expect(store.getSession(token, now + 499)).not.toBeNull();
    // At exactly expiresAt (exclusive upper bound ≡ expired at >=).
    expect(store.getSession(token, now + 500)).toBeNull();
    // The expired session is pruned: a subsequent call with an earlier clock still returns null.
    expect(store.getSession(token, now + 1)).toBeNull();
  });

  it("deleteSession removes the session", () => {
    const store = new InMemoryPortalSessionStore();
    const now = 1_000;
    const token = store.createSession("app_1", "user_42", now);
    store.deleteSession(token);
    expect(store.getSession(token, now + 1)).toBeNull();
  });

  it("deleteSession is a no-op for unknown tokens", () => {
    const store = new InMemoryPortalSessionStore();
    expect(() => store.deleteSession("no-such-token")).not.toThrow();
  });

  it("createSession respects a custom TTL", () => {
    const store = new InMemoryPortalSessionStore();
    const now = 0;
    const ttl = 60_000;
    const token = store.createSession("app_2", "user_99", now, ttl);
    const session = store.getSession(token, 1);
    expect(session!.expiresAt).toBe(now + ttl);
  });

  it("MAX_PORTAL_SESSION_TTL_MS is 7 days", () => {
    expect(MAX_PORTAL_SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });
});
