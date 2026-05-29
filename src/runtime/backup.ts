/**
 * The `posthorn admin backup` / `posthorn admin restore` commands — an **operator
 * snapshot/restore** of the SQLite data directory, taken online against a running
 * gateway.
 *
 * Posthorn's default backend is six independent SQLite files under `POSTHORN_DATA_DIR`
 * (see `resolveLocations` in `gateway.ts`). A correct backup must capture a
 * transactionally-consistent copy of each — naively `cp`-ing a live `.db` while the
 * worker is mid-write can copy a torn page or miss the `-wal` sidecar. SQLite's
 * `VACUUM INTO` is the canonical answer: it takes a read transaction and writes a
 * fresh, defragmented, single-file snapshot with no WAL/SHM sidecar, safe to run while
 * the gateway keeps serving (each store opens with a 5s busy-timeout, so a momentary
 * lock overlap waits rather than failing — see `db/sqlite.ts`).
 *
 * Restore is the inverse: validate a backup's manifest, then atomically drop each
 * snapshot file back into the data directory, clearing any stale `-wal`/`-shm`/`-journal`
 * sidecars so SQLite can never replay an old journal onto a fresh file. Restore
 * overwrites live data, so it refuses a non-empty data directory unless `--force` is
 * given (stop the gateway first).
 *
 * Postgres deployments don't use the data directory at all; there the right tools are
 * `pg_dump`/`pg_restore`, so this prints that runbook and declines rather than pretending
 * to snapshot a remote database it doesn't own.
 *
 * Following the codebase's pure-core / thin-I/O discipline, {@link runBackupCommand} is
 * the tested core: it takes its inputs (data directory, backend, version, clock) and
 * output sinks injected, and returns a process exit code. `main.ts` is the thin shell
 * that resolves these from the real config and wires the console.
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { MEMORY_DATA_DIR } from "./config.js";

// `node:sqlite` is loaded through createRequire for the same reason the stores do it:
// it is a genuine Node builtin, but bundlers whose builtin lists predate it choke on the
// static specifier. Requiring it keeps the lookup a runtime builtin resolution.
const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * The six SQLite store files a gateway writes under its data directory, in a fixed
 * order. This is the **allowlist** restore validates a manifest's file names against —
 * a backup can never name a path outside this set, so a hand-edited or hostile manifest
 * cannot make restore write outside the data directory.
 *
 * Kept in lockstep with `resolveLocations` (gateway.ts) by a drift test in
 * `backup.test.ts`, so adding a store there fails the gate until it is mirrored here.
 */
export const STORE_DB_FILENAMES = [
  "apps.db",
  "endpoints.db",
  "messages.db",
  "queue.db",
  "attempts.db",
  "event-types.db",
] as const;

/** SQLite sidecar suffixes that must be cleared when a fresh db file is restored in place. */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** The manifest format tag written into every backup, checked on restore. */
const BACKUP_FORMAT = "posthorn-backup/1";

/** Exit code: success. */
const EXIT_OK = 0;
/** Exit code: a usage error or a failed operation. */
const EXIT_ERR = 1;

/** One entry in a backup manifest: a store file and the size of its snapshot. */
interface BackupFileEntry {
  readonly name: string;
  readonly bytes: number;
}

/** The `manifest.json` written alongside the snapshot files in a backup directory. */
interface BackupManifest {
  readonly format: string;
  readonly posthornVersion: string;
  readonly backend: "sqlite";
  readonly createdAt: string;
  readonly files: readonly BackupFileEntry[];
}

/** Inputs and sinks a {@link runBackupCommand} invocation operates through. */
export interface BackupDeps {
  /** The gateway's resolved data directory (`config.dataDir`). */
  readonly dataDir: string;
  /**
   * The configured Postgres URL, if any (`config.databaseUrl`). When set the gateway
   * does not use the SQLite data directory, so backup/restore print the `pg_dump` runbook
   * and decline rather than snapshot a database they don't own.
   */
  readonly databaseUrl?: string | null | undefined;
  /** Build version, stamped into the manifest for provenance. */
  readonly version: string;
  /** Normal output sink (stdout in production; a capture buffer in tests). */
  readonly out: (line: string) => void;
  /** Error/diagnostic sink (stderr in production; a capture buffer in tests). */
  readonly err: (line: string) => void;
  /** Clock returning epoch ms for the manifest timestamp. Defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/** The `posthorn admin backup` / `restore` usage text, surfaced from {@link ADMIN_USAGE}. */
export const BACKUP_USAGE = `posthorn admin backup <dir>     Snapshot the SQLite data dir into <dir> (online, consistent)
  posthorn admin restore <dir> [--force]
                                    Restore a backup from <dir> into the data dir
                                    (--force overwrites an existing data dir — stop the gateway first)`;

/**
 * Execute `posthorn admin backup` or `posthorn admin restore`.
 *
 * @param args  the subcommand and its arguments — `["backup", dir]` or
 *              `["restore", dir, "--force"]` (i.e. `process.argv.slice(2)` after the
 *              leading `admin`).
 * @returns the process exit code: `0` on success, `1` on a usage error or a failed
 *          operation. Never throws for an expected failure — those are reported through
 *          {@link BackupDeps.err} and reflected in the exit code.
 */
export async function runBackupCommand(
  args: readonly string[],
  deps: BackupDeps,
): Promise<number> {
  const { databaseUrl, out, err } = deps;
  const [sub, ...rest] = args;

  // Postgres backend: the data directory is unused, so decline and point at pg_dump.
  if (databaseUrl) {
    return declinePostgres(sub, out);
  }

  // An in-memory store has nothing on disk to snapshot (or restore into).
  if (deps.dataDir === MEMORY_DATA_DIR) {
    err(`cannot ${sub ?? "back up"} an in-memory data store (POSTHORN_DATA_DIR=${MEMORY_DATA_DIR})`);
    err("Set POSTHORN_DATA_DIR to a filesystem path to enable backup/restore.");
    return EXIT_ERR;
  }

  switch (sub) {
    case "backup":
      return backup(rest, deps);
    case "restore":
      return restore(rest, deps);
    default:
      err(`unknown backup subcommand "${sub ?? ""}"`);
      err(BACKUP_USAGE);
      return EXIT_ERR;
  }
}

/** Print the `pg_dump`/`pg_restore` runbook for the Postgres backend and decline. */
function declinePostgres(sub: string | undefined, out: (line: string) => void): number {
  out("POSTHORN_DATABASE_URL is set — this gateway uses Postgres, not the SQLite data dir.");
  out("Use your database's native tooling instead:");
  out("");
  if (sub === "restore") {
    out("  # Restore a dump into the configured database:");
    out("  pg_restore --clean --if-exists --no-owner --dbname \"$POSTHORN_DATABASE_URL\" posthorn.dump");
  } else {
    out("  # Snapshot the configured database (custom format, compressed):");
    out("  pg_dump --format=custom --no-owner \"$POSTHORN_DATABASE_URL\" > posthorn.dump");
  }
  out("");
  out("See the \"Backup & restore\" section of docs/DEPLOY.md for the full runbook.");
  // Decline with exit 1: posthorn produced no backup/restore here, so a backup cron
  // sees a clear failure rather than a false success.
  return EXIT_ERR;
}

/** Snapshot every existing store file under the data dir into a fresh backup directory. */
function backup(rest: readonly string[], deps: BackupDeps): number {
  const { dataDir, version, out, err, now = Date.now } = deps;
  const destDir = positional(rest);
  if (destDir === undefined) {
    err("backup requires a destination directory");
    err("usage: posthorn admin backup <dir>");
    return EXIT_ERR;
  }

  // Refuse to write into a non-empty directory: a backup target should be fresh so we
  // never interleave with, or clobber, an unrelated directory's contents.
  if (existsSync(destDir) && readdirSync(destDir).length > 0) {
    err(`refusing to back up into non-empty directory "${destDir}"`);
    err("Choose a new (or empty) directory — e.g. a timestamped path for each backup.");
    return EXIT_ERR;
  }
  mkdirSync(destDir, { recursive: true });

  const files: BackupFileEntry[] = [];
  for (const name of STORE_DB_FILENAMES) {
    const srcPath = join(dataDir, name);
    // A store file only exists once that store has been opened. A freshly-provisioned
    // gateway may have apps.db but not yet, say, attempts.db — back up what exists and
    // record exactly that set, so restore reproduces the same shape.
    if (!existsSync(srcPath)) {
      continue;
    }
    const destPath = join(destDir, name);
    try {
      vacuumInto(srcPath, destPath);
    } catch (e) {
      err(`failed to back up ${name}: ${(e as Error).message}`);
      return EXIT_ERR;
    }
    files.push({ name, bytes: statSync(destPath).size });
  }

  if (files.length === 0) {
    err(`no SQLite store files found under "${dataDir}" — nothing to back up`);
    err("Has the gateway run against this data directory yet?");
    return EXIT_ERR;
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    posthornVersion: version,
    backend: "sqlite",
    createdAt: new Date(now()).toISOString(),
    files,
  };
  writeFileSync(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  out(`Backed up ${files.length} store${files.length === 1 ? "" : "s"} (${formatBytes(totalBytes)}) → ${destDir}`);
  for (const f of files) {
    out(`  ${f.name}  ${formatBytes(f.bytes)}`);
  }
  return EXIT_OK;
}

/** Restore a backup directory's snapshot files back into the data directory. */
function restore(rest: readonly string[], deps: BackupDeps): number {
  const { dataDir, out, err } = deps;
  const srcDir = positional(rest);
  const force = rest.includes("--force");
  if (srcDir === undefined) {
    err("restore requires a source directory");
    err("usage: posthorn admin restore <dir> [--force]");
    return EXIT_ERR;
  }

  // Validate the manifest and every referenced file BEFORE touching live data, so a bad
  // backup can never half-clobber a running deployment's data directory.
  const manifest = readManifest(srcDir, err);
  if (manifest === null) {
    return EXIT_ERR;
  }
  for (const entry of manifest.files) {
    if (!(STORE_DB_FILENAMES as readonly string[]).includes(entry.name)) {
      err(`backup manifest names an unknown store file "${entry.name}" — refusing to restore`);
      return EXIT_ERR;
    }
    if (!existsSync(join(srcDir, entry.name))) {
      err(`backup is missing file "${entry.name}" listed in its manifest — refusing to restore`);
      return EXIT_ERR;
    }
  }

  // Restore is destructive: it overwrites whatever store files already live in the data
  // dir. Guard a populated data dir behind --force so a stray restore can't silently
  // replace a live gateway's data.
  const existing = STORE_DB_FILENAMES.filter((name) => existsSync(join(dataDir, name)));
  if (existing.length > 0 && !force) {
    err(`refusing to overwrite existing data in "${dataDir}" (${existing.length} store file(s) present)`);
    err("Stop the gateway, then re-run with --force to replace the data directory.");
    return EXIT_ERR;
  }
  mkdirSync(dataDir, { recursive: true });

  for (const entry of manifest.files) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(dataDir, entry.name);
    // Write via a temp file + rename so a crash mid-copy never leaves a torn db in place.
    const tmpPath = `${destPath}.restore-tmp`;
    copyFileSync(srcPath, tmpPath);
    rmSync(destPath, { force: true });
    renameSync(tmpPath, destPath);
    // The snapshot is a single self-contained file; a leftover WAL/SHM/journal from the
    // old database would be replayed onto it and corrupt the read. Clear them.
    for (const suffix of SIDECAR_SUFFIXES) {
      rmSync(`${destPath}${suffix}`, { force: true });
    }
  }

  out(`Restored ${manifest.files.length} store${manifest.files.length === 1 ? "" : "s"} → ${dataDir}`);
  out(`  from backup taken ${manifest.createdAt} (posthorn ${manifest.posthornVersion})`);
  out("Start (or restart) the gateway to serve the restored data.");
  return EXIT_OK;
}

/**
 * Read and validate a backup's `manifest.json`. Returns the parsed manifest, or `null`
 * after reporting a precise reason through {@link err} (missing, unparseable, wrong
 * format/backend, or a malformed `files` list).
 */
function readManifest(srcDir: string, err: (line: string) => void): BackupManifest | null {
  const manifestPath = join(srcDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    err(`no manifest.json in "${srcDir}" — not a posthorn backup directory`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    err(`manifest.json is not valid JSON: ${(e as Error).message}`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    err("manifest.json is not a JSON object");
    return null;
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m["format"] !== "string" || !m["format"].startsWith("posthorn-backup/")) {
    err(`manifest.json is not a posthorn backup (format: ${JSON.stringify(m["format"])})`);
    return null;
  }
  if (m["backend"] !== "sqlite") {
    err(`backup backend is ${JSON.stringify(m["backend"])}, not "sqlite" — cannot restore here`);
    return null;
  }
  if (!Array.isArray(m["files"])) {
    err("manifest.json has no files list");
    return null;
  }
  const files: BackupFileEntry[] = [];
  for (const raw of m["files"]) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>)["name"] !== "string"
    ) {
      err("manifest.json files list has a malformed entry");
      return null;
    }
    const entry = raw as Record<string, unknown>;
    files.push({
      name: entry["name"] as string,
      bytes: typeof entry["bytes"] === "number" ? entry["bytes"] : 0,
    });
  }
  return {
    format: m["format"],
    posthornVersion: typeof m["posthornVersion"] === "string" ? m["posthornVersion"] : "unknown",
    backend: "sqlite",
    createdAt: typeof m["createdAt"] === "string" ? m["createdAt"] : "unknown",
    files,
  };
}

/**
 * Snapshot one SQLite database file to `destPath` using `VACUUM INTO`. Opens a second
 * connection to the (possibly live) source, which only needs a read transaction; the
 * destination is written as a fresh, defragmented, single-file database with no WAL/SHM
 * sidecar. `VACUUM INTO` requires the destination not to already exist, which the
 * empty-directory guard upstream guarantees.
 */
function vacuumInto(srcPath: string, destPath: string): void {
  const db: DatabaseSync = new SqliteDatabase(srcPath);
  try {
    // Single-quote the path as a SQL string literal, escaping embedded quotes by doubling.
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** First non-flag argument, or `undefined`. Flags are anything starting with `--`. */
function positional(rest: readonly string[]): string | undefined {
  return rest.find((a) => !a.startsWith("--"));
}

/** Render a byte count as a compact human-readable size (e.g. `1.2 MB`). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
