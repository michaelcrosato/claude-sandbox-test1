/**
 * In-memory session store for the tenant dashboard.
 *
 * A tenant session maps a random UUID token (placed in an httpOnly cookie) to the
 * tenant `appId` that authenticated it. Unlike the admin session store (which just
 * checks existence), the tenant store must carry the `appId` so every page can scope
 * its queries to the right tenant without re-authenticating on each request.
 *
 * Sessions are ephemeral by design — a gateway restart clears them and the tenant
 * logs in again, which is fine for a developer-debugging tool.
 */

import { randomUUID } from "node:crypto";

/** How long a tenant dashboard session survives without activity: 8 hours. */
export const TENANT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export interface TenantSessionStore {
  /** Create a new session for `appId` and return its opaque token. */
  createSession(appId: string, now: number): string;
  /**
   * Return the `appId` the token belongs to, or `null` if the token is unknown or
   * has expired. Expired sessions are pruned on access.
   */
  validateSession(token: string, now: number): string | null;
  /** Remove a session (logout). No-op for unknown tokens. */
  deleteSession(token: string): void;
}

interface TenantSession {
  readonly appId: string;
  readonly expiresAt: number;
}

export class InMemoryTenantSessionStore implements TenantSessionStore {
  readonly #sessions = new Map<string, TenantSession>();

  createSession(appId: string, now: number): string {
    const token = randomUUID();
    this.#sessions.set(token, { appId, expiresAt: now + TENANT_SESSION_TTL_MS });
    return token;
  }

  validateSession(token: string, now: number): string | null {
    const session = this.#sessions.get(token);
    if (session === undefined) return null;
    if (now >= session.expiresAt) {
      this.#sessions.delete(token);
      return null;
    }
    return session.appId;
  }

  deleteSession(token: string): void {
    this.#sessions.delete(token);
  }
}
