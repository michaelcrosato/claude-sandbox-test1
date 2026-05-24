/**
 * Portal session store — time-limited access tokens that let a SaaS tenant grant
 * one of their customers access to the consumer portal without sharing the tenant
 * API key. A session is minted server-side via `POST /v1/portal/sessions` (tenant
 * auth), then the customer is redirected to `/portal/login?token=<token>` which
 * exchanges it for an `HttpOnly` cookie for the portal UI.
 *
 * Sessions are ephemeral by design (in-memory only): a gateway restart forces a
 * re-mint, which is correct — the SaaS always controls when a customer can access
 * the portal and for how long.
 */

import { randomUUID } from "node:crypto";

/** Maximum portal session TTL: 7 days. */
export const MAX_PORTAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Default portal session TTL: 24 hours. */
export const DEFAULT_PORTAL_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * A portal session — a short-lived, tenant-scoped grant minted by a SaaS for one
 * of their customers. The session carries the tenant's `appId` (so every portal
 * query is automatically tenant-isolated) and an `externalUserId` (the SaaS
 * customer identifier, opaque to Posthorn — for logging and auditing).
 */
export interface PortalSession {
  readonly id: string;             // opaque token (stored as cookie; used to look up this record)
  readonly appId: string;          // the tenant this portal session is scoped to
  readonly externalUserId: string; // the SaaS customer identifier (opaque to Posthorn)
  readonly createdAt: number;      // epoch ms
  readonly expiresAt: number;      // epoch ms
}

export interface PortalSessionStore {
  /**
   * Mint a new portal session and return its opaque token. The token is stored
   * and later validated by {@link getSession}. `ttlMs` defaults to
   * {@link DEFAULT_PORTAL_SESSION_TTL_MS}; it is clamped to
   * {@link MAX_PORTAL_SESSION_TTL_MS} by the call-site.
   */
  createSession(appId: string, externalUserId: string, now: number, ttlMs?: number): string;

  /**
   * Return the session when the token is known and has not expired, or `null`.
   * Expired sessions are pruned on access (no background sweep needed).
   */
  getSession(token: string, now: number): PortalSession | null;

  /** Remove a session (logout / revoke). No-op for unknown tokens. */
  deleteSession(token: string): void;
}

export class InMemoryPortalSessionStore implements PortalSessionStore {
  readonly #sessions = new Map<string, PortalSession>();

  createSession(
    appId: string,
    externalUserId: string,
    now: number,
    ttlMs: number = DEFAULT_PORTAL_SESSION_TTL_MS,
  ): string {
    const id = randomUUID();
    this.#sessions.set(id, { id, appId, externalUserId, createdAt: now, expiresAt: now + ttlMs });
    return id;
  }

  getSession(token: string, now: number): PortalSession | null {
    const session = this.#sessions.get(token);
    if (session === undefined) return null;
    if (now >= session.expiresAt) {
      this.#sessions.delete(token);
      return null;
    }
    return session;
  }

  deleteSession(token: string): void {
    this.#sessions.delete(token);
  }
}
