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
 * Default maximum number of connections the shared pool opens to Postgres.
 *
 * Matches `pg`'s own default (10), so leaving `POSTHORN_PG_POOL_MAX` unset keeps
 * today's behavior byte-for-byte. It is exposed as a knob because the right value
 * is a per-deployment capacity decision the library cannot guess: Postgres caps
 * total connections server-side (`max_connections` — often ~100 on a managed
 * instance, far lower on small/shared tiers), and **every Posthorn replica
 * multiplies its pool against that one budget**. So `replicas × max` must stay
 * under the server cap (minus a margin for admin and other clients): lower this
 * when running many replicas against a small database; raise it for a single busy
 * replica that needs more than 10 concurrent queue/API connections in flight.
 */
export const DEFAULT_PG_POOL_MAX = 10;

/**
 * Maximum time (ms) a `pool.connect()` checkout may wait before failing with
 * `timeout exceeded when trying to connect` — bounding **both** establishing a
 * brand-new connection **and** waiting in the queue for a free slot when the pool
 * is already at its `max` busy connections.
 *
 * `pg` defaults this to `0` = wait **forever**. That is the pool-acquisition twin
 * of the infinite `lock_timeout` / `idle_in_transaction_session_timeout` defaults
 * closed above: under a connection-starved burst (a struggling database, or more
 * concurrent work than `max` connections), every delivery-worker tick and API
 * request that needs the database would otherwise block indefinitely rather than
 * failing fast with a retryable error the caller already handles — turning local
 * saturation into a whole-gateway hang. A finite bound sheds load instead. 10 s is
 * deliberately generous: Posthorn's hot-path queries are short, so a checkout that
 * cannot complete within 10 s means the pool is genuinely saturated (an
 * under-provisioned `max`, or a database in trouble) — exactly the condition where
 * failing fast beats hanging. Fixed, not an operator knob, for the same reason as
 * the two GUC timeouts: it only ever fires on a checkout that is already stuck.
 */
export const POSTGRES_CONNECTION_TIMEOUT_MS = 10_000;

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

/** Construction options for {@link createPostgresPool}. */
export interface PostgresPoolOptions {
  /**
   * Maximum pooled connections. Defaults to {@link DEFAULT_PG_POOL_MAX}. The
   * gateway threads `POSTHORN_PG_POOL_MAX` here; see {@link DEFAULT_PG_POOL_MAX}
   * for how to size it against the database's server-side connection budget.
   */
  readonly max?: number;
  /**
   * Checkout timeout in ms — bounds new-connection establishment *and* the
   * saturated-pool queue wait (see {@link POSTGRES_CONNECTION_TIMEOUT_MS}).
   * Defaults to {@link POSTGRES_CONNECTION_TIMEOUT_MS} and is **not** wired to an
   * env var (a fixed safety bound, like the GUC timeouts). Exposed only so a test
   * can prove the saturated-pool checkout fails fast without the full 10 s wait.
   */
  readonly connectionTimeoutMillis?: number;
  /**
   * Sink for the pool's `'error'` event — emitted when an **idle** pooled connection
   * is dropped by the *server*, not in response to any query: a database
   * restart/failover, a `pg_terminate_backend`, a server-side idle timeout, or a
   * network blip. Wired by the gateway to the structured logger.
   *
   * This is a **reliability-critical** hook, not mere observability. `pg.Pool` is an
   * `EventEmitter`, and Node re-throws an `'error'` event that has **no** listener —
   * so without one, a single dropped idle connection (an everyday event on managed
   * Postgres, which restarts for maintenance and recycles idle backends) takes down
   * the whole gateway process. `createPostgresPool` therefore *always* attaches a
   * listener; the error is recoverable (pg discards the broken client and opens a
   * fresh one on the next checkout), so the handler logs and swallows it. This sink
   * only chooses where that line goes; defaults to swallowing silently, which still
   * prevents the crash.
   */
  readonly onError?: (err: Error) => void;
  /**
   * Sink for a connection-**acquisition timeout** — a `pool.connect()` checkout that
   * could not be satisfied within {@link POSTGRES_CONNECTION_TIMEOUT_MS} because the pool
   * is at its `max` busy connections (saturation), or a brand-new connection's handshake
   * stalled. Wired by the gateway to the metrics counter
   * (`posthorn_pg_pool_acquire_timeouts_total`).
   *
   * This is the **saturation twin** of {@link onError}. Where `onError` fires on a severed
   * *idle* connection (the database dropping us, request-invisible and recoverable), this
   * fires when *our* side runs out of connections — back-pressure that **does** fail the
   * query/worker tick that hit it. The timeout already propagates to the caller as a
   * rejected query (which the worker/HTTP layers already handle); this sink does not change
   * that, it only *observes* the timeout so the otherwise-indistinguishable failure mode
   * becomes a dedicated, alertable series. The error is re-thrown unchanged after the sink
   * runs. Every pool acquisition is observed: `createPostgresPool` wraps the pool's
   * `connect`, through which `pool.query` also acquires, so both one-shot queries and
   * transaction checkouts are covered.
   */
  readonly onAcquireTimeout?: () => void;
}

/**
 * The two error messages `pg-pool` raises for a connection-acquisition timeout (the
 * `connectionTimeoutMillis` path) — there is no error `code` to match on, so the message
 * is the only signal. `'timeout exceeded when trying to connect'` is the saturated-pool
 * wait (every connection busy, the checkout queue timed out); `'Connection terminated due
 * to connection timeout'` is a brand-new connection whose handshake exceeded the bound.
 * Pinned to `pg-pool` (bundled with `pg` 8.x); a driver upgrade that reworded these would
 * surface as the acquire-timeout counter going quiet, caught by the live saturation smoke.
 */
const PG_ACQUIRE_TIMEOUT_MESSAGES: readonly string[] = [
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
];

/**
 * True when `err` is a `pg-pool` connection-acquisition timeout (see
 * {@link PG_ACQUIRE_TIMEOUT_MESSAGES}). Exported so the classification is unit-tested
 * independently of a live, saturated pool.
 */
export function isPgAcquireTimeoutError(err: unknown): boolean {
  return err instanceof Error && PG_ACQUIRE_TIMEOUT_MESSAGES.includes(err.message);
}

/**
 * Create a `pg.Pool` from a connection string (e.g.
 * `postgresql://user:pass@host:5432/dbname`).
 *
 * Every connection the pool opens is configured with Posthorn's standard safety
 * timeouts ({@link POSTGRES_LOCK_TIMEOUT_MS},
 * {@link POSTGRES_IDLE_IN_TXN_TIMEOUT_MS}) so no statement can block on a lock,
 * and no session can squat on locks inside an idle transaction, forever. The pool
 * itself is bounded too: at most `max` connections ({@link DEFAULT_PG_POOL_MAX} by
 * default), and a checkout that cannot be satisfied within
 * {@link POSTGRES_CONNECTION_TIMEOUT_MS} fails fast instead of waiting forever for
 * a slot — closing the last "wait forever" default on the Postgres path.
 *
 * The pool stays idle until the first query. Pass it to each store constructor,
 * then call `pool.end()` to drain connections during graceful shutdown.
 */
export function createPostgresPool(
  connectionString: string,
  options: PostgresPoolOptions = {},
): InstanceType<typeof Pool> {
  const max = options.max ?? DEFAULT_PG_POOL_MAX;
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`Postgres pool max must be a positive integer, got ${max}`);
  }
  const connectionTimeoutMillis =
    options.connectionTimeoutMillis ?? POSTGRES_CONNECTION_TIMEOUT_MS;
  if (!Number.isFinite(connectionTimeoutMillis) || connectionTimeoutMillis < 0) {
    throw new RangeError(
      `Postgres connectionTimeoutMillis must be a non-negative, finite number, ` +
        `got ${connectionTimeoutMillis}`,
    );
  }
  const pool = new Pool({
    connectionString,
    options: CONNECTION_OPTIONS,
    max,
    connectionTimeoutMillis,
  });
  // Always attach an 'error' listener. The pool emits 'error' when an *idle* client's
  // connection is severed by the server (a DB restart/failover, a terminated backend,
  // a network drop) — and Node throws an unhandled 'error' event, which would crash
  // the whole gateway on an everyday Postgres maintenance event. The pool recovers on
  // its own (the broken client is discarded; the next checkout opens a fresh one), so
  // the correct handling is to record and continue, never to die.
  pool.on("error", (err) => {
    options.onError?.(err);
  });

  // Observe connection-acquisition timeouts. Unlike the 'error' event above, pg emits *no*
  // pool event for a checkout that times out — it simply rejects the connect() call — so we
  // wrap connect(), the single seam every acquisition funnels through (pool.query() calls
  // this.connect() internally), and count the timeout before re-throwing it unchanged. Only
  // installed when a sink is wired, so the no-op default path stays the unmodified pg method.
  const { onAcquireTimeout } = options;
  if (onAcquireTimeout) {
    type PoolConnect = InstanceType<typeof Pool>["connect"];
    const originalConnect = pool.connect.bind(pool) as PoolConnect;
    const wrappedConnect = ((callback?: unknown): unknown => {
      if (typeof callback === "function") {
        // Callback form — used internally by pool.query(); inspect the err argument.
        const cb = callback as (err: Error, client: unknown, done: unknown) => void;
        type ConnectWithCallback = (
          cb: (err: Error, client: unknown, done: unknown) => void,
        ) => void;
        return (originalConnect as unknown as ConnectWithCallback)((err, client, done) => {
          if (err && isPgAcquireTimeoutError(err)) {
            onAcquireTimeout();
          }
          cb(err, client, done);
        });
      }
      // Promise form — used by store transaction checkouts; observe a rejection, re-throw.
      return (originalConnect as unknown as () => Promise<unknown>)().catch((err: unknown) => {
        if (isPgAcquireTimeoutError(err)) {
          onAcquireTimeout();
        }
        throw err;
      });
    }) as unknown as PoolConnect;
    pool.connect = wrappedConnect;
  }

  return pool;
}
