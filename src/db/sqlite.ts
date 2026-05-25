/**
 * Shared connection setup for all SQLite-backed stores (`node:sqlite`).
 *
 * Each store opens its **own** `DatabaseSync` handle to its own file under the
 * gateway's `dataDir`, and historically each repeated the same opening pragmas
 * inline. This module is the single source of truth for that configuration so
 * the six stores cannot drift, and so the busy-timeout below is applied
 * uniformly.
 */

// Type-only import: erased at build time, so it never reaches the bundler's
// module resolver (the value side of `node:sqlite` is loaded via createRequire
// in each store — see the note in `storage/sqlite-store.ts`).
import type { DatabaseSync } from "node:sqlite";

/**
 * Busy-timeout (ms) applied to every SQLite connection.
 *
 * `node:sqlite` defaults this to `0`: a write that cannot immediately acquire
 * the write lock fails at once with `SQLITE_BUSY` ("database is locked"). Within
 * a single Posthorn process that never happens — one connection per store file,
 * and `node:sqlite` is synchronous, so the event loop serializes every write — but
 * the product *supports* concurrent multi-process access to the same files, and
 * there the loser of a lock race would fail spuriously without this:
 *   - the `posthorn admin` CLI opens the same `apps.db` while the gateway runs
 *     (see `runtime/gateway.ts` `resolveLocations`);
 *   - a rolling deploy briefly runs the outgoing and incoming containers against
 *     the shared data dir at once;
 *   - online backup tooling (e.g. Litestream, `sqlite3 .backup`) takes a lock.
 *
 * With a busy-timeout set, SQLite instead retries internally for up to this long
 * before giving up, turning a hard error into a brief wait. The cost is bounded
 * and only paid under genuine contention: because `node:sqlite` is synchronous, a
 * real stall blocks the event loop for at most this duration — rare, and far
 * cheaper than a spuriously failed delivery or API call. 5 s is the widely
 * recommended default for a server-embedded SQLite database.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** Options for {@link applyConnectionPragmas}. */
export interface ConnectionPragmaOptions {
  /**
   * Enable foreign-key enforcement (`PRAGMA foreign_keys = ON`). Off by default;
   * stores whose schema declares foreign keys (apps, messages, event-types) pass
   * `true`, while the queue and attempt logs (no FKs) leave it off, preserving
   * each store's prior behaviour exactly.
   */
  readonly foreignKeys?: boolean;
}

/**
 * Apply Posthorn's standard opening pragmas to a freshly opened connection:
 * WAL journaling (crash-safe durability with concurrent readers; degrades to
 * in-memory journaling for a `:memory:` database), `synchronous = NORMAL` (the
 * WAL-appropriate durability/throughput balance), and a busy-timeout (see
 * {@link SQLITE_BUSY_TIMEOUT_MS}). Foreign-key enforcement is opt-in per store.
 *
 * Must be called before the schema is created and before any query, on a
 * connection outside a transaction.
 */
export function applyConnectionPragmas(
  db: Pick<DatabaseSync, "exec">,
  options: ConnectionPragmaOptions = {},
): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (options.foreignKeys) {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
