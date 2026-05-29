// CLI for the Posthorn throughput benchmark — a thin runner over the compiled harness in
// dist/bench/throughput.js (so it exercises the real production build, like the smokes).
//
// Usage:
//   npm run build && node bench/throughput.mjs [messages]
//
// Tunables (env, all optional):
//   BENCH_MESSAGES            messages to ingest                 (default 2000)
//   BENCH_PAYLOAD_BYTES       approx JSON payload size           (default 256)
//   BENCH_INGEST_CONCURRENCY  in-flight POST /v1/messages        (default 50)
//   BENCH_WORKER_CONCURRENCY  delivery-worker concurrency        (default 16)
//   BENCH_WORKER_BATCH_SIZE   delivery-worker claim batch        (default 64)
//   BENCH_SETTLE_TIMEOUT_MS   fail if delivery doesn't settle    (default 60000)
//
// This is a loopback PIPELINE benchmark (in-process receiver, :memory: store) — it measures
// Posthorn's own overhead, not the network. See BENCHMARKS.md for methodology and caveats.
import { runThroughputBench } from "../dist/bench/throughput.js";

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`FAIL: ${name} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

const messages = process.argv[2] ? Number(process.argv[2]) : intFromEnv("BENCH_MESSAGES", 2000);
if (!Number.isInteger(messages) || messages <= 0) {
  console.error(`FAIL: messages must be a positive integer, got "${process.argv[2]}"`);
  process.exit(1);
}

const options = {
  messages,
  payloadBytes: intFromEnv("BENCH_PAYLOAD_BYTES", 256),
  ingestConcurrency: intFromEnv("BENCH_INGEST_CONCURRENCY", 50),
  workerConcurrency: intFromEnv("BENCH_WORKER_CONCURRENCY", 16),
  workerBatchSize: intFromEnv("BENCH_WORKER_BATCH_SIZE", 64),
  settleTimeoutMs: intFromEnv("BENCH_SETTLE_TIMEOUT_MS", 60_000),
  logLevel: process.env["BENCH_LOG_LEVEL"] ?? "silent",
};

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const fmtMs = (ms) => `${(ms / 1000).toFixed(2)}s`;

console.log(
  `Posthorn throughput bench — ${fmt(options.messages)} messages, ~${options.payloadBytes}B payload, ` +
    `ingest×${options.ingestConcurrency}, worker×${options.workerConcurrency} (batch ${options.workerBatchSize})\n`,
);

const result = await runThroughputBench(options);

const rows = [
  ["ingest (accept 202)", result.ingest.count, result.ingest.elapsedMs, result.ingest.perSec],
  ["delivery (end-to-end)", result.delivery.count, result.delivery.elapsedMs, result.delivery.perSec],
];
const nameW = Math.max(...rows.map((r) => r[0].length));
console.log(`${"phase".padEnd(nameW)}   ${"count".padStart(8)}   ${"elapsed".padStart(9)}   ${"per sec".padStart(12)}`);
for (const [name, count, elapsedMs, perSec] of rows) {
  console.log(`${name.padEnd(nameW)}   ${fmt(count).padStart(8)}   ${fmtMs(elapsedMs).padStart(9)}   ${fmt(perSec).padStart(12)}`);
}

console.log(`\nBENCH_OK ${result.delivery.succeeded}/${result.messages} delivered`);
