import { describe, expect, it } from "vitest";
import { InMemorySessionStore, SESSION_TTL_MS } from "./sessions.js";

describe("InMemorySessionStore", () => {
  it("createSession returns a unique non-empty token", () => {
    const store = new InMemorySessionStore();
    const a = store.createSession(0);
    const b = store.createSession(0);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it("validateSession returns true for a live session", () => {
    const store = new InMemorySessionStore();
    const token = store.createSession(1_000);
    expect(store.validateSession(token, 2_000)).toBe(true);
  });

  it("validateSession returns false for an unknown token", () => {
    const store = new InMemorySessionStore();
    expect(store.validateSession("no-such-token", 0)).toBe(false);
  });

  it("validateSession returns false and prunes an expired session", () => {
    const store = new InMemorySessionStore();
    const created = 1_000;
    const token = store.createSession(created);
    // exactly at expiry boundary → expired
    expect(store.validateSession(token, created + SESSION_TTL_MS)).toBe(false);
    // second call also false (pruned after first)
    expect(store.validateSession(token, created + SESSION_TTL_MS + 1)).toBe(false);
  });

  it("deleteSession removes a live session", () => {
    const store = new InMemorySessionStore();
    const token = store.createSession(0);
    expect(store.validateSession(token, 1_000)).toBe(true);
    store.deleteSession(token);
    expect(store.validateSession(token, 1_000)).toBe(false);
  });

  it("deleteSession is a no-op for unknown tokens", () => {
    const store = new InMemorySessionStore();
    expect(() => store.deleteSession("ghost")).not.toThrow();
  });
});
