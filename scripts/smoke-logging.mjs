// Compiled-dist smoke: structured operational logging through production ESM.
// Proves the pure logger (level filtering, child binding, Error/bigint/circular
// serialization), and — end-to-end on a running gateway — that an HTTP request
// emits a structured JSON access line both through the default stdout sink and an
// injected logger, while `silent` stays quiet.
import {
  createLogger,
  formatJsonLine,
  SILENT_LOGGER,
} from "../dist/logging/logger.js";
import { createGateway } from "../dist/runtime/gateway.js";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── 1. Pure logger: level filtering ─────────────────────────────────────────
{
  const seen = [];
  const log = createLogger({ level: "warn", sink: (e) => seen.push(e), now: () => 0 });
  log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
  check("level filter: only warn+error clear a warn threshold",
    JSON.stringify(seen.map((x) => x.level)) === JSON.stringify(["warn", "error"]));
}

// ── 2. Pure logger: child binding merges component into fields ───────────────
{
  const seen = [];
  const log = createLogger({ level: "debug", sink: (e) => seen.push(e), now: () => 0 })
    .child({ component: "worker" });
  log.info("tick", { count: 3 });
  check("child: bound component merged with per-call fields",
    seen[0].fields.component === "worker" && seen[0].fields.count === 3);
}

// ── 3. formatJsonLine: schema + Error/bigint/circular handling ───────────────
{
  const line = formatJsonLine({ time: "T", level: "info", msg: "m", fields: { a: 1 } });
  check("format: single-line JSON, reserved keys first",
    line === '{"time":"T","level":"info","msg":"m","a":1}' && !line.includes("\n"));

  const errLine = JSON.parse(
    formatJsonLine({ time: "T", level: "error", msg: "x", fields: { err: new TypeError("boom") } }),
  );
  check("format: Error serialized to name/message/stack (not {})",
    errLine.err.name === "TypeError" && errLine.err.message === "boom" && typeof errLine.err.stack === "string");

  const bigLine = JSON.parse(formatJsonLine({ time: "T", level: "info", msg: "b", fields: { n: 10n } }));
  check("format: bigint stringified", bigLine.n === "10");

  const circ = {}; circ.self = circ;
  const circLine = JSON.parse(formatJsonLine({ time: "T", level: "warn", msg: "c", fields: { circ } }));
  check("format: circular structure falls back without throwing",
    circLine.msg === "c" && circLine.fields_error === "unserializable log fields");
}

// ── 4. SILENT_LOGGER discards everything ─────────────────────────────────────
{
  let wrote = false;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => { wrote = true; return true; };
  try { SILENT_LOGGER.info("nope", { x: 1 }); SILENT_LOGGER.error("nope", { err: new Error("x") }); }
  finally { process.stdout.write = orig; }
  check("SILENT_LOGGER: no output", wrote === false);
  check("SILENT_LOGGER: child returns itself", SILENT_LOGGER.child({ a: 1 }) === SILENT_LOGGER);
}

/** Build a full GatewayConfig with the given log level. */
function cfg(logLevel) {
  return {
    host: "127.0.0.1", port: 0, dataDir: ":memory:", maxBodyBytes: 1_000_000,
    adminToken: null, endpointAutoDisableAfterMs: 0, retentionDays: 0,
    defaultRateLimit: null, allowPrivateNetworks: true, logLevel,
    worker: { batchSize: 10, concurrency: 4, requestTimeoutMs: 5_000, idlePollMs: 50, visibilityTimeoutMs: 30_000 },
    fanout: { graceMs: 500, batchSize: 10, idlePollMs: 50 },
  };
}

// Capture everything written to stdout while running `fn`.
async function captureStdout(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    void rest;
    return true;
  };
  try { await fn(); } finally { process.stdout.write = orig; }
  return lines.join("").split("\n").filter((l) => l.trim() !== "");
}

// ── 5. Running gateway, DEFAULT stdout sink: a request emits a JSON access line ─
{
  const gw = createGateway(cfg("info")); // default JSON-to-stdout logger
  const { port } = await gw.start();
  const lines = await captureStdout(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/endpoints`);
    check("gateway(default sink): unauthenticated request → 401", res.status === 401);
    // Give the synchronous access-log write a tick to land on stdout.
    await new Promise((r) => setTimeout(r, 20));
  });
  await gw.stop();

  const access = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((o) => o && o.msg === "request" && o.path === "/v1/endpoints");
  check("gateway(default sink): a parseable JSON access line reached stdout", access !== undefined);
  check("gateway(default sink): access line carries component/method/status",
    access.component === "http" && access.method === "GET" && access.status === 401);
  check("gateway(default sink): access line has a numeric durationMs", typeof access.durationMs === "number");
  // The /healthz probe is logged at debug, so it must NOT appear at the info default.
  check("gateway(default sink): no probe spam in the info stream",
    !lines.some((l) => l.includes('"path":"/healthz"')));
}

// ── 6. Running gateway, INJECTED logger: access line captured structurally ───
{
  const entries = [];
  const logger = createLogger({ level: "info", sink: (e) => entries.push(e) });
  const gw = createGateway(cfg("info"), { logger, instanceId: "smoke-inst" });
  const { port } = await gw.start();
  const res = await fetch(`http://127.0.0.1:${port}/v1/endpoints`);
  check("gateway(injected): request → 401", res.status === 401);
  await gw.stop();

  const access = entries.find((e) => e.msg === "request");
  check("gateway(injected): structured access entry with component:http",
    access && access.fields.component === "http" && access.fields.status === 401);
  // The gateway binds its identity onto whatever logger it is handed, so the
  // embedder's sink receives instance + version on every line (not just lifecycle).
  check("gateway(injected): every line carries bound instance + version",
    access.fields.instance === "smoke-inst" && typeof access.fields.version === "string");
  const started = entries.find((e) => e.msg === "gateway started");
  check("gateway(injected): structured 'gateway started' line with bound address",
    started && started.fields.component === "gateway" && started.fields.port === port &&
    started.fields.instance === "smoke-inst");
  check("gateway(injected): structured 'gateway stopped' line on clean shutdown",
    entries.filter((e) => e.msg === "gateway stopped").length === 1);
}

// ── 7. silent level: a request produces no stdout output ─────────────────────
{
  const gw = createGateway(cfg("silent"));
  const { port } = await gw.start();
  const lines = await captureStdout(async () => {
    await fetch(`http://127.0.0.1:${port}/v1/endpoints`);
    await new Promise((r) => setTimeout(r, 20));
  });
  await gw.stop();
  check("gateway(silent): no log lines emitted", lines.length === 0);
}

// ── 8. Running gateway, DEFAULT stdout sink: lifecycle is uniform JSON Lines ──
// The defect this closes: lifecycle output used to be a human `console.log`, so the
// stdout stream mixed prose with JSON and broke JSON log ingestion. Capture start()
// AND stop() and prove every emitted line is parseable JSON, including boot/stop.
{
  const gw = createGateway(cfg("info"));
  let port;
  const lines = await captureStdout(async () => {
    ({ port } = await gw.start());
    await gw.stop();
  });
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  check("gateway(default sink): every lifecycle stdout line is valid JSON",
    parsed.length > 0 && parsed.every((o) => o !== null));
  const started = parsed.find((o) => o && o.msg === "gateway started");
  check("gateway(default sink): 'gateway started' on stdout with numeric port + version",
    started && started.level === "info" && typeof started.port === "number" &&
    started.port === port && typeof started.version === "string" && typeof started.instance === "string");
  check("gateway(default sink): 'gateway stopped' on stdout",
    parsed.some((o) => o && o.msg === "gateway stopped" && o.component === "gateway"));
}

console.log(`\nAll ${passed}/22 logging smoke checks PASS ✓`);
