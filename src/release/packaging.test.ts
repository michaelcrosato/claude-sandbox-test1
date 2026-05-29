import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

// Release-packaging guard. The published npm tarball must ship the compiled
// entrypoints (library, bin, type declarations) and must NOT ship test files
// or source maps. This is a regression guard for the `files` allowlist in
// package.json: npm ignores `.npmignore` when a `files` field is present, so
// the negation patterns in `files` are the only thing keeping tests and maps
// out of the tarball. Removing them silently re-bloats the package.

interface PackResult {
  name: string;
  version: string;
  files: string[];
}

function npmPack(): PackResult {
  const raw = execSync("npm pack --dry-run --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const entry = parsed[0];
  return {
    name: entry.name,
    version: entry.version,
    files: entry.files.map((f: { path: string }) => f.path.replace(/\\/g, "/")),
  };
}

describe("npm publish packaging", () => {
  let pack: PackResult;

  beforeAll(() => {
    // `npm pack` lists files present on disk that match `files`; the compiled
    // output must exist for the assertions below to be meaningful.
    if (!existsSync("dist/index.js")) {
      execSync("npm run build", { stdio: "inherit" });
    }
    pack = npmPack();
  }, 180_000);

  it("publishes under the expected package identity", () => {
    expect(pack.name).toBe("posthorn");
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("ships the compiled library, bin, and type-declaration entrypoints", () => {
    expect(pack.files).toContain("dist/index.js");
    expect(pack.files).toContain("dist/index.d.ts");
    expect(pack.files).toContain("dist/main.js"); // bin: posthorn
  });

  it("excludes compiled test files from the tarball", () => {
    expect(pack.files.filter((f) => /\.test\./.test(f))).toEqual([]);
  });

  it("excludes source maps from the tarball", () => {
    expect(pack.files.filter((f) => f.endsWith(".map"))).toEqual([]);
  });

  it("ships only dist output plus standard package metadata", () => {
    const allowed = /^(package\.json|readme(\..*)?|license(\..*)?|licence(\..*)?|changelog(\..*)?|notice(\..*)?)$/i;
    const stray = pack.files.filter((f) => !f.startsWith("dist/") && !allowed.test(f));
    expect(stray).toEqual([]);
  });
});
