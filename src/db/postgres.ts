/**
 * Shared PostgreSQL connection pool factory for all Postgres-backed stores.
 *
 * Each store takes a `Pool` from its caller so the pool lifecycle (creation,
 * graceful shutdown, size tuning) is owned by the composition root, not the
 * store. A single pool is shared across all stores in a gateway instance —
 * Postgres connection limits are precious.
 */

import pg from "pg";

const { Pool } = pg;

export type { Pool } from "pg";
export type { PoolClient } from "pg";

/**
 * Create a `pg.Pool` from a connection string (e.g.
 * `postgresql://user:pass@host:5432/dbname`).
 *
 * The pool stays idle until the first query. Pass it to each store constructor,
 * then call `pool.end()` to drain connections during graceful shutdown.
 */
export function createPostgresPool(connectionString: string): InstanceType<typeof Pool> {
  return new Pool({ connectionString });
}
