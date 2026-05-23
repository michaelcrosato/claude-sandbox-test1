/**
 * The Posthorn build version, read once from the adjacent `package.json`.
 *
 * Sourced via `createRequire` rather than a static `import … with { type: "json" }`
 * for the same reason `node:sqlite` is required dynamically elsewhere: a static
 * JSON import (and its import-attributes syntax) is the kind of thing a bundler or
 * an older test runner can choke on, whereas `require` of a JSON file is a plain,
 * universally-supported runtime read. The relative path holds in every shipping
 * layout — `src/version.ts` → repo-root `package.json` under Vitest, and the
 * compiled `dist/version.js` → the `package.json` copied beside `dist/` in the
 * Docker image. If the file is somehow not found, we degrade to `"unknown"` so a
 * cosmetic version label can never break a real code path (e.g. `/metrics`).
 */

import { createRequire } from "node:module";

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version?: unknown;
    };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** The running build's semantic version (from `package.json`), or `"unknown"`. */
export const POSTHORN_VERSION = readVersion();
