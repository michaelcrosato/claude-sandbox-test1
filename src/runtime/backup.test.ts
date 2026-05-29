import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SqliteAppStore } from "../apps/sqlite-app-store.js";
import { SqliteEndpointStore } from "../endpoints/sqlite-endpoint-store.js";
import { resolveLocations } from "./gateway.js";
import { runBackupCommand, STORE_DB_FILENAMES, type BackupDeps } from "./backup.js";

/**
 * A test rig: a throwaway temp root with a `data/` dir to back up and a `backups/` dir
 * to write into, plus stdout/stderr capture buffers and a fixed clock so the manifest
 * timestamp is deterministic.
 */
function makeRig(databaseUrl?: string): {
  root: string;
  dataDir: string;
  out: string[];
  err: string[];
  run: (...args: string[]) => Promise<number>;
} {
  const root = mkdtempSync(join(tmpdir(), "posthorn-backup-"));
  const dataDir = join(root, "data");
  const out: string[] = [];
  const err: string[] = [];
  const deps: BackupDeps = {
    dataDir,
    databaseUrl: databaseUrl ?? null,
    version: "9.9.9-test",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => 1_700_000_000_000, // fixed → 2023-11-14T22:13:20.000Z
  };
  return {
    root,
    dataDir,
    out,
    err,
    run: (...args: string[]) => runBackupCommand(args, deps),
  };
}

const rigs: string[] = [];
function rig(databaseUrl?: string): ReturnType<typeof makeRig> {
  const r = makeRig(databaseUrl);
  rigs.push(r.root);
  return r;
}
afterEach(() => {
  while (rigs.length > 0) {
    const root = rigs.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Seed a data dir with a real app+key and an endpoint, returning the ids written. */
async function seed(dataDir: string): Promise<{ appId: string; endpointId: string; secret: string }> {
  const locations = resolveLocations(dataDir);
  const apps = new SqliteAppStore({ location: locations.apps });
  const endpoints = new SqliteEndpointStore({ location: locations.endpoints });
  try {
    const app = await apps.create({ name: "Acme" });
    const { secret } = await apps.createApiKey(app.id);
    const endpoint = await endpoints.create({ appId: app.id, url: "https://example.com/hook" });
    return { appId: app.id, endpointId: endpoint.id, secret };
  } finally {
    apps.close();
    endpoints.close();
  }
}

describe("runBackupCommand", () => {
  describe("file-name allowlist", () => {
    // The restore-side allowlist must mirror resolveLocations exactly, or a backup of a
    // newly-added store would silently be dropped on restore. Catch drift in the gate.
    it("matches the store layout resolveLocations produces", () => {
      const dir = mkdtempSync(join(tmpdir(), "posthorn-layout-"));
      try {
        const locations = resolveLocations(dir);
        const fromLayout = Object.values(locations).map((p) => basename(p)).sort();
        expect([...STORE_DB_FILENAMES].sort()).toEqual(fromLayout);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("backup → restore round-trip", () => {
    it("backs up a live data dir and restores it intact into an empty dir", async () => {
      const source = rig();
      const seeded = await seed(source.dataDir);
      const backupDir = join(source.root, "backups", "b1");

      // Back up the seeded data dir.
      expect(await source.run("backup", backupDir)).toBe(0);
      expect(source.err).toEqual([]);
      expect(existsSync(join(backupDir, "manifest.json"))).toBe(true);
      expect(existsSync(join(backupDir, "apps.db"))).toBe(true);
      expect(existsSync(join(backupDir, "endpoints.db"))).toBe(true);

      // Manifest is well-formed and self-describing.
      const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
      expect(manifest.format).toBe("posthorn-backup/1");
      expect(manifest.backend).toBe("sqlite");
      expect(manifest.posthornVersion).toBe("9.9.9-test");
      expect(manifest.createdAt).toBe("2023-11-14T22:13:20.000Z");
      const names = (manifest.files as { name: string }[]).map((f) => f.name);
      expect(names).toContain("apps.db");
      expect(names).toContain("endpoints.db");

      // Restore into a fresh, empty data dir (a different rig = different location).
      const target = rig();
      expect(await target.run("restore", backupDir)).toBe(0);
      expect(target.err).toEqual([]);

      // The restored data is byte-intact: same app, key (authenticates), and endpoint.
      const apps = new SqliteAppStore({ location: resolveLocations(target.dataDir).apps });
      const endpoints = new SqliteEndpointStore({
        location: resolveLocations(target.dataDir).endpoints,
      });
      try {
        const app = await apps.get(seeded.appId);
        expect(app?.name).toBe("Acme");
        const authed = await apps.authenticate(seeded.secret);
        expect(authed?.id).toBe(seeded.appId);
        const endpoint = await endpoints.get(seeded.endpointId);
        expect(endpoint?.url).toBe("https://example.com/hook");
      } finally {
        apps.close();
        endpoints.close();
      }
    });

    it("refuses to overwrite a populated data dir without --force, but proceeds with it", async () => {
      const source = rig();
      await seed(source.dataDir);
      const backupDir = join(source.root, "backups", "b2");
      expect(await source.run("backup", backupDir)).toBe(0);

      // The target already holds live data → refuse without --force.
      const target = rig();
      await seed(target.dataDir);
      expect(await target.run("restore", backupDir)).toBe(1);
      expect(target.err.join("\n")).toContain("refusing to overwrite");

      // With --force the restore proceeds and the data dir reflects the backup's app.
      expect(await target.run("restore", backupDir, "--force")).toBe(0);
      const apps = new SqliteAppStore({ location: resolveLocations(target.dataDir).apps });
      try {
        const all = await apps.list();
        // Both seeds named "Acme"; the point is restore succeeded and the store opens cleanly.
        expect(all.length).toBeGreaterThanOrEqual(1);
      } finally {
        apps.close();
      }
    });
  });

  describe("usage and validation errors", () => {
    it("requires a destination for backup", async () => {
      const r = rig();
      expect(await r.run("backup")).toBe(1);
      expect(r.err.join("\n")).toContain("requires a destination");
    });

    it("requires a source for restore", async () => {
      const r = rig();
      expect(await r.run("restore")).toBe(1);
      expect(r.err.join("\n")).toContain("requires a source");
    });

    it("refuses an unknown subcommand", async () => {
      const r = rig();
      expect(await r.run("frobnicate")).toBe(1);
      expect(r.err.join("\n")).toContain('unknown backup subcommand "frobnicate"');
    });

    it("refuses to back up an empty data dir (gateway never ran)", async () => {
      const r = rig();
      expect(await r.run("backup", join(r.root, "out"))).toBe(1);
      expect(r.err.join("\n")).toContain("nothing to back up");
    });

    it("refuses to back up into a non-empty directory", async () => {
      const r = rig();
      await seed(r.dataDir);
      const dest = join(r.root, "dest");
      // Pre-populate the destination so it is non-empty.
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "stray.txt"), "x");
      expect(await r.run("backup", dest)).toBe(1);
      expect(r.err.join("\n")).toContain("non-empty directory");
    });

    it("refuses to restore a directory with no manifest", async () => {
      const r = rig();
      const notABackup = join(r.root, "notabackup");
      mkdirSync(notABackup, { recursive: true });
      expect(await r.run("restore", notABackup)).toBe(1);
      expect(r.err.join("\n")).toContain("not a posthorn backup");
    });

    it("refuses a manifest naming a store file outside the allowlist (path-traversal guard)", async () => {
      const r = rig();
      const evil = join(r.root, "evil");
      mkdirSync(evil, { recursive: true });
      writeFileSync(
        join(evil, "manifest.json"),
        JSON.stringify({
          format: "posthorn-backup/1",
          backend: "sqlite",
          posthornVersion: "x",
          createdAt: "x",
          files: [{ name: "../../etc/passwd", bytes: 1 }],
        }),
      );
      expect(await r.run("restore", evil)).toBe(1);
      expect(r.err.join("\n")).toContain("unknown store file");
    });
  });

  describe("backend / store guards", () => {
    it("declines and prints the pg_dump runbook when a Postgres URL is configured", async () => {
      const r = rig("postgres://localhost/posthorn");
      expect(await r.run("backup", join(r.root, "out"))).toBe(1);
      expect(r.out.join("\n")).toContain("pg_dump");
      expect(r.out.join("\n")).toContain("POSTHORN_DATABASE_URL is set");
    });

    it("prints pg_restore guidance for the restore subcommand under Postgres", async () => {
      const r = rig("postgres://localhost/posthorn");
      expect(await r.run("restore", join(r.root, "in"))).toBe(1);
      expect(r.out.join("\n")).toContain("pg_restore");
    });

    it("refuses to operate on an in-memory data store", async () => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runBackupCommand(["backup", "anywhere"], {
        dataDir: ":memory:",
        databaseUrl: null,
        version: "x",
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("in-memory data store");
    });
  });
});
