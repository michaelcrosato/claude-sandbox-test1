import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPostgresPool,
  DEFAULT_PG_POOL_MAX,
  isPgAcquireTimeoutError,
  POSTGRES_CONNECTION_TIMEOUT_MS,
  POSTGRES_IDLE_IN_TXN_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
} from "./postgres.js";

// Pool *configuration* needs no database: `createPostgresPool` constructs the pool
// lazily (no connection opens until the first query), so these inspect the resolved
// `pool.options` and run in the canonical gate without a live Postgres. The bogus
// host is never contacted.
describe("createPostgresPool — pool configuration (no database needed)", () => {
  // An unreachable, syntactically-valid URL: construction stores it but never dials.
  const URL = "postgres://u:p@unreachable.invalid:5432/db";

  it("defaults the pool size to DEFAULT_PG_POOL_MAX and bounds checkout with a finite timeout", async () => {
    const pool = createPostgresPool(URL);
    try {
      expect(pool.options.max).toBe(DEFAULT_PG_POOL_MAX);
      // The fix: a non-zero checkout timeout. pg defaults this to 0 = wait forever
      // for a free connection; assert the factory replaces that with a finite bound.
      expect(pool.options.connectionTimeoutMillis).toBe(POSTGRES_CONNECTION_TIMEOUT_MS);
      expect(pool.options.connectionTimeoutMillis ?? 0).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("applies a caller-supplied pool max (the POSTHORN_PG_POOL_MAX path)", async () => {
    const pool = createPostgresPool(URL, { max: 3 });
    try {
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });

  it("rejects a non-positive or non-integer pool max", () => {
    expect(() => createPostgresPool(URL, { max: 0 })).toThrow(RangeError);
    expect(() => createPostgresPool(URL, { max: -1 })).toThrow(RangeError);
    expect(() => createPostgresPool(URL, { max: 2.5 })).toThrow(RangeError);
  });

  it("attaches an 'error' listener so a severed idle connection cannot crash the process", async () => {
    const seen: Error[] = [];
    const pool = createPostgresPool(URL, { onError: (e) => seen.push(e) });
    try {
      // Exactly one handler is registered — the guard against Node re-throwing an
      // 'error' event that has no listener (which would take the process down).
      expect(pool.listenerCount("error")).toBe(1);
      // Reproduce what a Postgres restart/failover does to an idle pooled client:
      // the pool emits 'error'. With the listener attached this must NOT throw (an
      // unlistened 'error' emit does), and the sink must receive the error.
      const dropped = new Error("terminating connection due to administrator command");
      expect(() => pool.emit("error", dropped, undefined as never)).not.toThrow();
      expect(seen).toEqual([dropped]);
    } finally {
      await pool.end(); // never dialed (bogus host) — resolves immediately
    }
  });
});

// The acquisition-timeout classifier is the one brittle part of the saturation
// counter — pg gives no error `code`, only a message — so it is pinned here without
// needing a live, saturated pool. The end-to-end interception (the connect() wrapper
// actually firing the sink on a real timeout) is proven in the gated suite below.
describe("isPgAcquireTimeoutError — classifies a pg-pool acquisition timeout", () => {
  it("matches both messages pg-pool raises for a connectionTimeoutMillis timeout", () => {
    // Saturated-pool wait (every connection busy, checkout queue timed out).
    expect(isPgAcquireTimeoutError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    // Slow new-connection handshake exceeding the bound.
    expect(
      isPgAcquireTimeoutError(new Error("Connection terminated due to connection timeout")),
    ).toBe(true);
  });

  it("does not match other connection errors, so the counter tracks only saturation", () => {
    // A severed idle connection (the onError path) — a different failure mode.
    expect(
      isPgAcquireTimeoutError(new Error("terminating connection due to administrator command")),
    ).toBe(false);
    expect(isPgAcquireTimeoutError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isPgAcquireTimeoutError(new Error("getaddrinfo ENOTFOUND db.invalid"))).toBe(false);
    // A SQL-level statement timeout is unrelated to pool acquisition.
    expect(isPgAcquireTimeoutError(new Error("canceling statement due to lock timeout"))).toBe(false);
  });

  it("is false for non-Error values (never throws on an odd rejection)", () => {
    expect(isPgAcquireTimeoutError(undefined)).toBe(false);
    expect(isPgAcquireTimeoutError(null)).toBe(false);
    expect(isPgAcquireTimeoutError("timeout exceeded when trying to connect")).toBe(false);
    expect(isPgAcquireTimeoutError({ message: "timeout exceeded when trying to connect" })).toBe(
      false,
    );
  });
});

// Gated like every other Postgres suite: skipped unless a live database is
// reachable. Run locally with a throwaway container:
//   docker run -d --rm -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=posthorn_test -p 5455:5432 postgres:16
//   POSTHORN_TEST_PG_URL=postgres://postgres:pw@127.0.0.1:5455/posthorn_test npx vitest run src/db/postgres.test.ts
const pgUrl = process.env.POSTHORN_TEST_PG_URL;

if (!pgUrl) {
  describe.skip("createPostgresPool — skipped (POSTHORN_TEST_PG_URL not set)", () => {});
} else {
  describe("createPostgresPool connection timeouts", () => {
    const pool = createPostgresPool(pgUrl);

    afterAll(async () => {
      await pool.end();
    });

    it("opens every connection with Posthorn's lock + idle-in-transaction timeouts", async () => {
      // pg_settings reports both GUCs in their base unit (milliseconds), so the
      // numeric setting equals the constants the factory injected — confirming the
      // `-c …` startup options actually reached the backend.
      const { rows } = await pool.query<{ name: string; setting: string }>(
        "SELECT name, setting FROM pg_settings" +
          " WHERE name IN ('lock_timeout', 'idle_in_transaction_session_timeout')",
      );
      const ms = Object.fromEntries(rows.map((r) => [r.name, Number(r.setting)]));
      expect(ms.lock_timeout).toBe(POSTGRES_LOCK_TIMEOUT_MS);
      expect(ms.idle_in_transaction_session_timeout).toBe(POSTGRES_IDLE_IN_TXN_TIMEOUT_MS);
    });

    it(
      "cancels a statement blocked on a row lock within lock_timeout — never hangs forever",
      async () => {
        // Unique scratch table: the PG suites share one database, so a fixed name
        // could collide with a parallel run.
        const table = `lock_probe_${randomUUID().replace(/-/g, "")}`;
        await pool.query(`CREATE TABLE ${table} (id INT PRIMARY KEY)`);
        try {
          await pool.query(`INSERT INTO ${table} (id) VALUES (1)`);

          const holder = await pool.connect();
          const blocked = await pool.connect();
          try {
            // `holder` takes and keeps the row lock.
            await holder.query("BEGIN");
            await holder.query(`SELECT * FROM ${table} WHERE id = 1 FOR UPDATE`);

            // `blocked` wants the same lock. With the default lock_timeout = 0 this
            // would wait for `holder` indefinitely; the factory's finite timeout
            // turns it into a prompt, classifiable failure instead.
            await blocked.query("BEGIN");
            const start = Date.now();
            let code: string | undefined;
            try {
              await blocked.query(`SELECT * FROM ${table} WHERE id = 1 FOR UPDATE`);
              throw new Error("expected the blocked SELECT FOR UPDATE to be cancelled by lock_timeout");
            } catch (err) {
              code = (err as { code?: string }).code;
            }
            const elapsed = Date.now() - start;
            await blocked.query("ROLLBACK").catch(() => {});

            // 55P03 = lock_not_available ("canceling statement due to lock timeout").
            expect(code).toBe("55P03");
            // Bounds prove the timeout is genuinely in force: it neither returned
            // instantly (the default would *wait*, not fail) nor hung indefinitely.
            expect(elapsed).toBeGreaterThanOrEqual(POSTGRES_LOCK_TIMEOUT_MS * 0.5);
            expect(elapsed).toBeLessThan(POSTGRES_LOCK_TIMEOUT_MS * 2);
          } finally {
            await holder.query("ROLLBACK").catch(() => {});
            holder.release();
            blocked.release();
          }
        } finally {
          await pool.query(`DROP TABLE IF EXISTS ${table}`);
        }
      },
      POSTGRES_LOCK_TIMEOUT_MS * 3,
    );
  });

  describe("createPostgresPool checkout timeout — never waits forever for a connection", () => {
    it(
      "fails a checkout fast when the pool is saturated, and counts it via onAcquireTimeout",
      async () => {
        // max:1 so a single held client saturates the pool. An explicit short
        // connection timeout proves the bound is honored without the 10 s
        // production wait — the same shape as the lock_timeout test above.
        const timeoutMs = 250;
        let acquireTimeouts = 0;
        const pool = createPostgresPool(pgUrl, {
          max: 1,
          connectionTimeoutMillis: timeoutMs,
          onAcquireTimeout: () => {
            acquireTimeouts += 1;
          },
        });
        try {
          const held = await pool.connect(); // claims the only slot
          const start = Date.now();
          let message: string | undefined;
          try {
            // With pg's default connectionTimeoutMillis = 0 this checkout would
            // block forever waiting for `held` to be released. The finite bound
            // turns the saturated pool into a prompt, classifiable failure.
            await pool.connect();
            throw new Error("expected the saturated-pool checkout to time out");
          } catch (err) {
            message = (err as Error).message;
          }
          const elapsed = Date.now() - start;
          held.release();

          // The error still propagates unchanged — the wrapper only *observes* it.
          expect(message).toMatch(/timeout exceeded when trying to connect/);
          // ...and the sink fired exactly once for the one timed-out checkout, so the
          // metrics counter would tick. This is the saturation series' load-bearing path.
          expect(acquireTimeouts).toBe(1);
          // Bounds prove the timeout is genuinely in force: it neither failed
          // instantly (a real wait happened) nor hung indefinitely.
          expect(elapsed).toBeGreaterThanOrEqual(timeoutMs * 0.5);
          expect(elapsed).toBeLessThan(timeoutMs * 8);
        } finally {
          await pool.end();
        }
      },
      10_000,
    );

    it(
      "leaves the happy path untouched — query() and connect() succeed without firing the sink",
      async () => {
        // The connect() wrapper sits in front of *every* acquisition (pool.query
        // checks out internally too), so a bug there would break all DB access. Prove
        // both acquisition paths still work and the sink never fires on success.
        let acquireTimeouts = 0;
        const pool = createPostgresPool(pgUrl, {
          onAcquireTimeout: () => {
            acquireTimeouts += 1;
          },
        });
        try {
          // One-shot query path (Pool.query → this.connect(callback)).
          const viaQuery = await pool.query<{ n: number }>("SELECT 1 AS n");
          expect(viaQuery.rows[0]?.n).toBe(1);

          // Transaction-checkout path (await pool.connect() → promise form).
          const client = await pool.connect();
          try {
            const viaCheckout = await client.query<{ n: number }>("SELECT 2 AS n");
            expect(viaCheckout.rows[0]?.n).toBe(2);
          } finally {
            client.release();
          }

          expect(acquireTimeouts).toBe(0);
        } finally {
          await pool.end();
        }
      },
      10_000,
    );
  });
}
