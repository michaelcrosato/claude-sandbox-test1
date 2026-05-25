import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConnectionPragmas, SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.js";

// Load node:sqlite the same way the stores do (createRequire, not a static
// import) so Vite's bundler never tries to resolve the builtin specifier.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

describe("SQLITE_BUSY_TIMEOUT_MS", () => {
  it("is a positive, finite ms value — never 0 (0 means fail-fast with SQLITE_BUSY on contention)", () => {
    // This is the whole point of the constant: a regression to 0 would reinstate
    // the "database is locked" failure under multi-process lock contention.
    expect(Number.isFinite(SQLITE_BUSY_TIMEOUT_MS)).toBe(true);
    expect(SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("applyConnectionPragmas", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posthorn-pragmas-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets WAL, synchronous=NORMAL, and the busy-timeout on a file-backed connection", () => {
    const db = new DatabaseSync(join(dir, "p.db"));
    try {
      applyConnectionPragmas(db);
      expect(
        (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
          .journal_mode,
      ).toBe("wal");
      // SQLite synchronous levels: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
      expect(
        (db.prepare("PRAGMA synchronous").get() as { synchronous: number })
          .synchronous,
      ).toBe(1);
      // `PRAGMA busy_timeout` (no argument) reports the current setting; its
      // result column is named `timeout`.
      expect(
        (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      ).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  // node:sqlite's DatabaseSync enables foreign keys by default, so isolate the
  // helper's own effect by opening with that default turned off first.
  it("does not force foreign keys on when not requested, but still applies the busy-timeout", () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    try {
      applyConnectionPragmas(db);
      expect(
        (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
          .foreign_keys,
      ).toBe(0);
      expect(
        (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      ).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it("enables foreign keys when requested", () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    try {
      applyConnectionPragmas(db, { foreignKeys: true });
      expect(
        (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
          .foreign_keys,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
});
