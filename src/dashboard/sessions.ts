/**
 * In-memory session store for the admin dashboard.
 *
 * A dashboard session is a random UUID token placed in an httpOnly cookie at
 * login. The store maps that token to an expiry time; {@link validateSession}
 * pruning expired entries on access keeps memory bounded without a separate
 * sweep. Sessions are ephemeral by design — a gateway restart clears them and
 * the operator logs in again, matching the expectation for an admin tool.
 */

import { randomUUID } from "node:crypto";

/** How long a dashboard session survives without activity: 8 hours. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export interface SessionStore {
  /** Create a new session and return its opaque token. */
  createSession(now: number): string;
  /** Return true only if the token exists and has not expired. Prunes on expiry. */
  validateSession(token: string, now: number): boolean;
  /** Remove a session (logout). No-op for unknown tokens. */
  deleteSession(token: string): void;
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, number>(); // token → expiresAt

  createSession(now: number): string {
    const token = randomUUID();
    this.#sessions.set(token, now + SESSION_TTL_MS);
    return token;
  }

  validateSession(token: string, now: number): boolean {
    const expiresAt = this.#sessions.get(token);
    if (expiresAt === undefined) return false;
    if (now >= expiresAt) {
      this.#sessions.delete(token);
      return false;
    }
    return true;
  }

  deleteSession(token: string): void {
    this.#sessions.delete(token);
  }
}
