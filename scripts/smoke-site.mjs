// Compiled-dist smoke: the static-site generator end-to-end.
//
// Builds the real `site/` via buildSite() (which imports the dist OpenAPI builder), then
// asserts the four artifacts exist and carry their load-bearing content: the spec round-trips
// the gateway's own document, the API reference wires up Redoc with the spec inlined, the
// landing page carries the README's wedge/comparison + pricing, and the quick start has the
// copy-paste curl. No gateway and no network — the generator is hermetic.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../dist/index.js";
import { buildSite } from "./build-site.mjs";

let passed = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
  passed++;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const siteDir = path.join(repoRoot, "site");

const written = await buildSite(siteDir);
check("buildSite wrote all four artifacts", written.length === 4);

const read = (name) => readFile(path.join(siteDir, name), "utf8");

// ── openapi.json: byte-faithful to the gateway's own document ───────────────────────
const rawSpec = await read("openapi.json");
const parsed = JSON.parse(rawSpec);
const fresh = buildOpenApiDocument();
check("openapi.json is OpenAPI 3.1 titled Posthorn", parsed.openapi === "3.1.0" && parsed.info.title === "Posthorn");
check(
  "openapi.json round-trips the dist builder exactly",
  JSON.stringify(parsed) === JSON.stringify(fresh),
);
const opCount = Object.values(parsed.paths)
  .flatMap((item) => Object.values(item))
  .filter((op) => op && typeof op === "object" && "operationId" in op).length;
check("openapi.json carries the full operation set", opCount >= 40);

// ── api.html: Redoc, spec inlined so it renders offline ─────────────────────────────
const api = await read("api.html");
check("api.html loads the Redoc bundle", api.includes("redoc.standalone.js"));
check("api.html initializes Redoc", api.includes("Redoc.init("));
check("api.html inlines the spec (renders without a server)", api.includes('"openapi":"3.1.0"'));
// The inlined JS object literal must contain no raw "<" — that would close the <script> early.
const specLiteral = api.slice(api.indexOf("var posthornSpec = ") + "var posthornSpec = ".length, api.indexOf("Redoc.init("));
check("api.html escapes < inside the inlined spec (no <script> break-out)", specLiteral.length > 0 && !specLiteral.includes("<"));

// ── index.html: the wedge + comparison + pricing, transcribed from the README ───────
const index = await read("index.html");
check("landing carries the tagline", index.includes("Reliable webhook delivery for SaaS teams"));
check("landing carries the comparison wedge", index.includes("Why Posthorn") && index.includes("Svix") && index.includes("Convoy"));
check("landing carries the pricing claim", index.includes("$0, generous free tier") || index.includes("generous free tier"));
check("landing links to the API reference and quick start", index.includes('href="api.html"') && index.includes('href="getting-started.html"'));

// ── getting-started.html: copy-paste quick start + SDK/CLI pointers ─────────────────
const gs = await read("getting-started.html");
check("quick start has the docker build + send-message curl", gs.includes("docker build -t posthorn") && gs.includes("/v1/messages"));
check("quick start points at both SDKs and the CLI", gs.includes("pip install posthorn") && gs.includes("PosthornClient") && gs.includes("posthorn client send"));

console.log(`\nSITE_SMOKE_PASS ${passed}/${passed}`);
