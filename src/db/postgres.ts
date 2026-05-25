/**
 * Shared PostgreSQL connection pool factory for all Postgres-backed stores.
 *
 * Each store takes a `Pool` from its caller so the pool lifecycle (creation,
 * graceful shutdown, size tuning) is owned by the composition root, not the
 * store. A single pool is shared across all stores in a gateway instance —
 * Postgres connection limits are precious.
 *
 * This is also the single source of truth for the per-connection safety
 * timeouts every pooled connection opens with (see {@link createPostgresPool}),
 * the Postgres analogue of the SQLite busy-timeout in `db/sqlite.ts`.
 */

import pg from "pg";

const { Pool } = pg;

export type { Pool } from "pg";
export type { PoolClient } from "pg";

/**
 * Maximum time (ms) a statement will wait to **acquire a lock** before failing
 * with a clean `lock_timeout` error (Postgres `55P03`).
 *
 * This is the direct analogue of SQLite's busy-timeout (`db/sqlite.ts`): both
 * bound how long a write may sit blocked behind another holder of the lock.
 * Their default polarity is opposite, which is exactly why both matter — SQLite
 * defaults to `0` = *fail instantly*, so we raise it to wait; Postgres defaults
 * `lock_timeout` to `0` = *wait forever*, so we lower it to fail fast.
 *
 * Posthorn supports a horizontally-scaled, multi-replica deployment on a shared
 * Postgres (the reason the PG backend exists), and the delivery queue takes row
 * locks: `claimDue` uses `FOR UPDATE SKIP LOCKED` (never blocks), but the
 * single-task mutators — `complete`/`fail`/`retry`/`cancel`/`postpone` — take a
 * plain `FOR UPDATE`. A manual API `retry`/`cancel` colliding with a worker's
 * `fail` on the *same* task row would, with the default `lock_timeout = 0`,
 * block the loser **indefinitely**, pinning one of the pool's precious
 * connections until the holder commits. With a finite `lock_timeout` the loser
 * instead fails promptly with a retryable error the caller already handles,
 * rather than hanging a connection. 5 s matches the SQLite busy-timeout so the
 * two backends behave alike under contention.
 */
export const POSTGRES_LOCK_TIMEOUT_MS = 5_000;

/**
 * Maximum time (ms) a session may sit **idle inside an open transaction**
 * before Postgres aborts it (terminating that backend connection; the pool
 * transparently recreates it).
 *
 * `idle_in_transaction_session_timeout` defaults to `0` (never). A session that
 * has run `BEGIN` and then stalls between statements keeps holding every row
 * lock it has taken — a `FOR UPDATE` zombie that blocks every other replica's
 * queue mutators for as long as it lives. Posthorn never *intends* to hold a
 * transaction open across slow work (the delivery HTTP POST happens *outside*
 * the queue transaction — `claimDue` commits before delivery; `complete`/`fail`
 * open a fresh, short transaction afterward), so a transaction still open after
 * this long is a stuck/crashed peer, and aborting it to release its locks is
 * pure recovery. Set comfortably above `lock_timeout` so a healthy transaction
 * that is merely *waiting on a lock* trips the lock-timeout first, and an
 * idle-in-transaction abort unambiguously means a stalled session.
 *
 * `statement_timeout` is deliberately **not** set here: the data pruner
 * (`POSTHORN_RETENTION_DAYS`) issues bulk `DELETE`s whose first sweep over a
 * large pre-existing table can legitimately run long, and a global statement
 * cap would abort that real work. The two timeouts above only ever fire on a
 * *blocked* or *stalled* statement, never on one making progress.
 */
export const POSTGRES_IDLE_IN_TXN_TIMEOUT_MS = 10_000;

/**
 * The `-c key=value` startup options applied to every connection the pool opens.
 * Postgres reads a bare integer GUC as milliseconds (`5000` ⇒ `5s`), so these
 * are sent as-is. Set at connection handshake — before any query can run — so
 * there is no window in which a statement executes without the timeouts, and no
 * extra round-trip per connection.
 */
const CONNECTION_OPTIONS =
  `-c lock_timeout=${POSTGRES_LOCK_TIMEOUT_MS}` +
  ` -c idle_in_transaction_session_timeout=${POSTGRES_IDLE_IN_TXN_TIMEOUT_MS}`;

/**
 * Create a `pg.Pool` from a connection string (e.g.
 * `postgresql://user:pass@host:5432/dbname`).
 *
 * Every connection the pool opens is configured with Posthorn's standard safety
 * timeouts ({@link POSTGRES_LOCK_TIMEOUT_MS},
 * {@link POSTGRES_IDLE_IN_TXN_TIMEOUT_MS}) so no statement can block on a lock,
 * and no session can squat on locks inside an idle transaction, forever.
 *
 * The pool stays idle until the first query. Pass it to each store constructor,
 * then call `pool.end()` to drain connections during graceful shutdown.
 */
export function createPostgresPool(connectionString: string): InstanceType<typeof Pool> {
  return new Pool({ connectionString, options: CONNECTION_OPTIONS });
}
