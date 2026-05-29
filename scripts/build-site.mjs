// Static-site generator for Posthorn's public docs + landing page.
//
// Hermetic: it imports the *compiled* OpenAPI builder from dist (the same document the
// gateway serves at GET /openapi.json) and renders a self-contained `site/` — no running
// gateway, no network at build time. Three pages plus the raw spec:
//
//   site/openapi.json        the OpenAPI 3.1 contract (also handy for client codegen)
//   site/index.html          the landing page (the wedge + comparison table from the README)
//   site/api.html            the API reference (Redoc, spec inlined so it opens offline)
//   site/getting-started.html  copy-paste quick start + SDK/CLI pointers
//
// Each page inlines its own CSS so it works opened directly from disk (file://) with no
// server. Redoc's bundle is the one runtime fetch — pulled from a CDN at *view* time, in
// the browser; the build itself stays offline. Run via `npm run build:site`; the output
// dir is a build artifact (gitignored, like dist/). `scripts/smoke-site.mjs` validates it.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildOpenApiDocument } from "../dist/index.js";

const REDOC_CDN = "https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js";

// HTML-escape text destined for element content / attributes.
function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The shared look: one small, dependency-free stylesheet inlined into every page so each
// file stands alone. Deliberately restrained — system fonts, a single accent, no JS.
const BASE_CSS = `
  :root {
    --ink: #14213d; --muted: #5b6478; --line: #e4e7ee; --bg: #ffffff;
    --soft: #f6f8fc; --accent: #2b59ff; --accent-ink: #ffffff; --good: #0a7d4d;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; color: var(--ink); background: var(--bg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 0 24px; }
  header.site { border-bottom: 1px solid var(--line); }
  header.site .wrap { display: flex; align-items: center; justify-content: space-between; height: 64px; }
  header.site .brand { font-weight: 700; font-size: 18px; color: var(--ink); }
  header.site nav a { margin-left: 22px; color: var(--muted); font-weight: 500; }
  header.site nav a:hover { color: var(--ink); }
  .hero { background: linear-gradient(180deg, var(--soft), #fff); border-bottom: 1px solid var(--line); }
  .hero .wrap { padding: 72px 24px 64px; }
  .hero h1 { font-size: 44px; line-height: 1.1; margin: 0 0 16px; letter-spacing: -0.02em; }
  .hero p.lead { font-size: 20px; color: var(--muted); margin: 0 0 28px; max-width: 640px; }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; }
  .btn {
    display: inline-block; padding: 11px 20px; border-radius: 8px; font-weight: 600;
    border: 1px solid var(--line); color: var(--ink); background: #fff;
  }
  .btn:hover { text-decoration: none; border-color: var(--accent); }
  .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .btn.primary:hover { filter: brightness(1.05); }
  section { padding: 48px 0; border-bottom: 1px solid var(--line); }
  section h2 { font-size: 26px; margin: 0 0 20px; letter-spacing: -0.01em; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  thead th { color: var(--muted); font-weight: 600; }
  td.win, th.win { background: var(--soft); }
  td.win { color: var(--good); font-weight: 600; }
  ul.caps { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
  ul.caps li { padding-left: 26px; position: relative; }
  ul.caps li::before { content: "✓"; position: absolute; left: 0; color: var(--good); font-weight: 700; }
  ul.caps strong { color: var(--ink); }
  pre {
    background: #0f1525; color: #e7ecf7; border-radius: 10px; padding: 18px 20px;
    overflow: auto; font: 13.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  p code, li code { background: var(--soft); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; font-size: 0.92em; }
  footer.site { padding: 32px 0; color: var(--muted); font-size: 14px; }
  footer.site .wrap { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
`;

function siteHeader(active) {
  const link = (href, label) =>
    `<a href="${href}"${active === href ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="site"><div class="wrap">
    <a class="brand" href="index.html">Posthorn</a>
    <nav>
      ${link("getting-started.html", "Get started")}
      ${link("api.html", "API reference")}
      <a href="https://github.com/michaelcrosato/claude-sandbox-test1">GitHub</a>
    </nav>
  </div></header>`;
}

function siteFooter(version) {
  return `<footer class="site"><div class="wrap">
    <span>Posthorn v${esc(version)} — MIT licensed.</span>
    <span>Reliable webhook delivery. Single container, no Redis.</span>
  </div></footer>`;
}

function page({ title, version, active, body, head = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="Reliable, signed, observable webhook delivery. Single container, no Redis, MIT-licensed." />
<style>${BASE_CSS}</style>
${head}
</head>
<body>
${siteHeader(active)}
${body}
${siteFooter(version)}
</body>
</html>
`;
}

// The wedge, transcribed from the README's "Why Posthorn" comparison so the landing page
// carries the same claims. Last column (Posthorn) is the winning one.
const COMPARISON = {
  head: ["", "Svix", "Convoy", "Posthorn"],
  rows: [
    ["License", "source-available", "MIT", "MIT"],
    ["Self-host deps", "Postgres + Redis", "Postgres + Redis", "none (SQLite built-in)"],
    ["Library mode", "partial", "no", "yes — embed in any Node app"],
    ["Standard Webhooks", "yes", "partial", "yes, first-class"],
    ["Entry price", "$0 → $490/mo", "$99/mo", "$0, generous free tier"],
  ],
};

const CAPABILITIES = [
  ["Standard Webhooks signing", "<code>whsec_</code> secrets, HMAC-SHA256, replay-window enforcement, multi-token rotation."],
  ["Crash-safe retries", "Exponential backoff, 8 attempts over ~28h; at-least-once via a leased, store-backed queue — no Redis."],
  ["Idempotent intake", "A producer's retried send deduplicates on the original and never double-fans-out."],
  ["Zero-downtime secret rotation", "Old + new secrets both verify during a configurable overlap window (default 24h)."],
  ["Auto-disable dead endpoints", "A persistently-failing endpoint is taken out of rotation, capping wasted retries and billed operations."],
  ["Per-attempt audit log", "“attempt 3: HTTP 503 after 1.2s” — the data you actually debug a flaky receiver from."],
  ["Usage metering + quotas", "Accepted messages and delivery operations metered per tenant; monthly caps with <code>429</code> on breach."],
];

function renderComparison() {
  const head = COMPARISON.head
    .map((h, i) => `<th${i === 3 ? ' class="win"' : ""}>${i === 3 ? "<strong>Posthorn</strong>" : esc(h)}</th>`)
    .join("");
  const rows = COMPARISON.rows
    .map((cells) => {
      const tds = cells
        .map((c, i) => {
          if (i === 0) return `<th scope="row">${esc(c)}</th>`;
          if (i === 3) return `<td class="win">${esc(c)}</td>`;
          return `<td>${esc(c)}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("\n        ");
  return `<table>
      <thead><tr>${head}</tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

function landingPage(version) {
  const caps = CAPABILITIES.map(
    ([title, text]) => `<li><strong>${esc(title)}</strong> — ${text}</li>`,
  ).join("\n      ");
  const body = `
  <div class="hero"><div class="wrap">
    <h1>Reliable webhook delivery for SaaS teams.</h1>
    <p class="lead">Posthorn handles the hard parts of sending webhooks to your customers —
      signed, retried, and observable — with the operational simplicity that Svix and Convoy
      lack: a single process backed by SQLite, durable queue built in, zero runtime dependencies.</p>
    <div class="cta">
      <a class="btn primary" href="getting-started.html">Get started</a>
      <a class="btn" href="api.html">API reference</a>
      <a class="btn" href="https://github.com/michaelcrosato/claude-sandbox-test1">View on GitHub</a>
    </div>
  </div></div>

  <section><div class="wrap">
    <h2>Why Posthorn</h2>
    ${renderComparison()}
  </div></section>

  <section><div class="wrap">
    <h2>What you get</h2>
    <ul class="caps">
      ${caps}
    </ul>
  </div></section>

  <section style="border-bottom:none"><div class="wrap">
    <h2>Pricing</h2>
    <p>Self-host the MIT core for free — there are no per-message fees and nothing to license.
      The optional managed tier starts at <strong>$0 with a generous free tier</strong>, versus
      $99/mo (Convoy) and up to $490/mo (Svix) for comparable hosted plans.</p>
  </div></section>`;
  return page({ title: "Posthorn — reliable webhook delivery", version, active: "index.html", body });
}

function apiPage(spec, version) {
  // Inline the spec (with `<` escaped to keep the JSON safely inside the <script>) and hand
  // it to Redoc.init, so the reference renders even when the file is opened directly.
  const specLiteral = JSON.stringify(spec).replace(/</g, "\\u003c");
  const head = `<style>
  /* Pin the slim site header above Redoc's own full-height layout. */
  #redoc { display: block; }
</style>`;
  const body = `
  <div id="redoc"></div>
  <script src="${REDOC_CDN}"></script>
  <script>
    var posthornSpec = ${specLiteral};
    Redoc.init(posthornSpec, { hideDownloadButton: false, expandResponses: "200,201" }, document.getElementById("redoc"));
  </script>`;
  return page({ title: "Posthorn API reference", version, active: "api.html", body, head });
}

function gettingStartedPage(version) {
  const body = `
  <section><div class="wrap">
    <h2>Quick start</h2>
    <p>Run the gateway in one container, bootstrap a tenant, and send your first event.</p>
    <pre><code># 1. Build and run
docker build -t posthorn .
docker run -d --name posthorn -p 3000:3000 -v posthorn-data:/data \\
  -e POSTHORN_ADMIN_TOKEN=your-secret-admin-token \\
  posthorn

# 2. Bootstrap a tenant (one-time)
docker run --rm -v posthorn-data:/data posthorn admin create-app "Acme"
docker run --rm -v posthorn-data:/data posthorn admin create-key app_xxx
#  secret: phk_...  &larr; save this; shown once

# 3. Send your first webhook
curl -sX POST localhost:3000/v1/messages \\
  -H "Authorization: Bearer phk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"eventType":"user.created","payload":{"id":42}}'
# -&gt; 202 Accepted</code></pre>
  </div></section>

  <section><div class="wrap">
    <h2>Client libraries</h2>
    <p>Drive the same tenant surface from code or your shell:</p>
    <ul class="caps">
      <li><strong>TypeScript / JavaScript</strong> — <code>import { PosthornClient } from "posthorn"</code>. Full async client plus <code>verifyWebhook</code> for receivers.</li>
      <li><strong>Python</strong> — <code>pip install posthorn</code>; a zero-dependency, standard-library-only port with the same surface and wire contract.</li>
      <li><strong>Command line</strong> — <code>posthorn client send user.created '{"id":42}'</code>. Read commands print JSON to stdout, so they pipe to <code>jq</code>.</li>
    </ul>
  </div></section>

  <section style="border-bottom:none"><div class="wrap">
    <h2>Verify what you receive</h2>
    <p>Every delivery carries a Standard Webhooks signature. Verify it against the raw body
      <em>before</em> parsing — both SDKs ship a one-call verifier that raises on a bad
      signature, a replayed timestamp, or a missing header.</p>
    <p>The full request/response contract for every route is in the
      <a href="api.html">API reference</a>.</p>
  </div></section>`;
  return page({ title: "Posthorn — getting started", version, active: "getting-started.html", body });
}

// Render the whole site into `outDir`. Returns the list of written paths (the smoke uses it).
export async function buildSite(outDir) {
  const spec = buildOpenApiDocument();
  const version = spec.info.version;
  await mkdir(outDir, { recursive: true });

  const files = {
    "openapi.json": JSON.stringify(spec, null, 2) + "\n",
    "index.html": landingPage(version),
    "api.html": apiPage(spec, version),
    "getting-started.html": gettingStartedPage(version),
  };

  const written = [];
  for (const [name, contents] of Object.entries(files)) {
    const dest = path.join(outDir, name);
    await writeFile(dest, contents, "utf8");
    written.push(dest);
  }
  return written;
}

// Run directly (`node scripts/build-site.mjs [outDir]`) → build into ./site by default.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, "site");
  const written = await buildSite(outDir);
  for (const f of written) console.log(`wrote ${path.relative(repoRoot, f)}`);
  console.log(`\nSITE_BUILD_OK ${written.length} files → ${path.relative(repoRoot, outDir) || "."}`);
}
