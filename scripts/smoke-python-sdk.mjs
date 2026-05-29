// Compiled-dist smoke: the Posthorn Python SDK, end-to-end against a live in-process
// gateway, plus cross-language Standard Webhooks signing interop.
//
// The Node side boots the *compiled* dist gateway (the real production path), mints a
// tenant key via POST /v1/signup, and starts a tiny local 127.0.0.1 sink that 200s every
// request (so the endpoint the Python SDK creates has a reachable, hermetic destination —
// no public-internet delivery). It then runs clients/python/tests/e2e.py against that
// gateway. The Python script exercises the whole PosthornClient surface, asserts its
// OPERATIONS map exactly partitions the live /openapi.json (the drift guard), and verifies
// a Node-produced webhook signature. This harness closes the interop loop in the other
// direction: it signs a vector with the dist signer, hands it to Python to verify, and
// then verifies Python's own signature (captured from stdout) with the dist verifier —
// proving a webhook signed by either side validates on the other.
//
// Hits 127.0.0.1 (the IPv4 bind), matching the other dist smokes. Requires `python` on
// PATH (override with $PYTHON); the package is import-only (no install) via PYTHONPATH.
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/runtime/config.js";
import { createGateway } from "../dist/runtime/gateway.js";
import { sign, verify } from "../dist/signing/webhook-signature.js";

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
const clientsPythonDir = path.join(repoRoot, "clients", "python");
const e2ePath = path.join(clientsPythonDir, "tests", "e2e.py");
const pythonExe = process.env["PYTHON"] || "python";

// A local sink: 200 for every request, draining the body so the socket closes cleanly.
const sink = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});
await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
const sinkUrl = `http://127.0.0.1:${sink.address().port}/hook`;

// The dist gateway, in-memory, private-network delivery allowed (the sink is on 127.0.0.1),
// signup enabled so the smoke can mint its own key with no store access.
const config = loadConfig({
  POSTHORN_HOST: "127.0.0.1",
  POSTHORN_PORT: "0",
  POSTHORN_DATA_DIR: ":memory:",
  POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "true",
  POSTHORN_SIGNUP_ENABLED: "true",
});
const gw = createGateway(config);
const { port } = await gw.start();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const signup = await fetch(`${baseUrl}/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Python SDK Smoke" }),
  });
  const minted = await signup.json();
  check(
    "signup minted an API key for the smoke",
    signup.status === 201 && typeof minted.secret === "string",
  );
  const apiKey = minted.secret;

  // A fixed Standard Webhooks vector signed by the *dist* signer (the gateway's own
  // implementation) for the Node→Python half of the interop check.
  const interopSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const interopId = "msg_py_interop";
  const interopTs = 1_700_000_000;
  const interopPayload = JSON.stringify({ event: "interop.check", n: 7 });
  const nodeSig = sign(interopSecret, {
    id: interopId,
    timestamp: interopTs,
    payload: interopPayload,
  });

  // Spawn Python *asynchronously* (not spawnSync): the gateway runs in this same Node
  // event loop, so a synchronous spawn would block it and the gateway could not answer the
  // Python client's requests. Awaiting an async child keeps the loop serving.
  const result = await new Promise((resolve) => {
    const child = spawn(pythonExe, [e2ePath], {
      env: {
        ...process.env,
        POSTHORN_URL: baseUrl,
        POSTHORN_API_KEY: apiKey,
        POSTHORN_SINK_URL: sinkUrl,
        PYTHONPATH: clientsPythonDir,
        PYTHONIOENCODING: "utf-8",
        POSTHORN_INTEROP_SECRET: interopSecret,
        POSTHORN_INTEROP_ID: interopId,
        POSTHORN_INTEROP_TS: String(interopTs),
        POSTHORN_INTEROP_PAYLOAD: interopPayload,
        POSTHORN_INTEROP_SIG: nodeSig,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ error, status: null, stdout, stderr }));
    child.on("close", (status) => resolve({ error: null, status, stdout, stderr }));
  });

  if (result.error) {
    console.error(`FAIL: could not run "${pythonExe}" (set $PYTHON to your interpreter)`);
    console.error(result.error.message);
    process.exit(1);
  }
  // Surface the Python script's own output (its ✓ lines and any failure detail).
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  check("python e2e exited 0", result.status === 0);
  check("python e2e reported PY_SDK_E2E_PASS", /PY_SDK_E2E_PASS \d+\/\d+/.test(result.stdout));

  // Python→Node: verify the signature Python produced (captured from stdout) with the dist
  // verifier, and confirm it is byte-for-byte identical to the one Node signed.
  const m = result.stdout.match(/PY_INTEROP_SIG=(\S+)/);
  check("python emitted its interop signature", m !== null);
  const pySig = m[1];
  check("Python's signature equals Node's (same HMAC over the same content)", pySig === nodeSig);

  let verified = true;
  try {
    verify(
      interopSecret,
      { id: interopId, timestamp: interopTs, signature: pySig },
      interopPayload,
      { now: interopTs },
    );
  } catch {
    verified = false;
  }
  check("a Python-signed webhook verifies in Node", verified);
} finally {
  await gw.stop();
  await new Promise((resolve) => sink.close(resolve));
}

console.log(`\nPYTHON_SDK_SMOKE_PASS ${passed}/${passed}`);
