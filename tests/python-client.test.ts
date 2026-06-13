import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGateway,
  hashApiKey,
  openStorage,
  runDeliveryWorkerTick,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 101).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');
const activeGateways: Gateway[] = [];

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (gateway !== undefined) {
      await gateway.stop();
    }
  }
});

describe('Posthorn Python SDK', () => {
  it('exercises tenant HTTP routes and stable API errors', async () => {
    const python = findPython();
    const { address, storage } = await startSeededGateway();

    const created = await runPythonJson<{ readonly endpoint_id: string; readonly message_id: string }>(
      python,
      `
import json
import os
from posthorn import PosthornApiError, PosthornClient

client = PosthornClient(os.environ["POSTHORN_URL"], os.environ["POSTHORN_API_KEY"])

created = client.create_endpoint(
    "https://example.com/hooks/python",
    event_types=["python.created"],
    headers={"X-SDK": "python"},
    rate_limit_per_second=3,
)
assert created["endpoint"]["id"].startswith("ep_")
assert created["secret"].startswith("whsec_")
assert created["endpoint"]["rateLimitPerSecond"] == 3

listed = client.list_endpoints()
assert len(listed) == 1
assert listed[0]["id"] == created["endpoint"]["id"]
assert listed[0]["headers"] == {"X-SDK": "python"}
assert listed[0]["rateLimitPerSecond"] == 3

first = client.send_message("python.created", {"id": 1}, idempotency_key="python-1")
same = client.send_message("python.created", {"id": 1}, idempotency_key="python-1")
assert same == first
assert first["fanout"]["matched"] == 1

batch = client.send_message_batch([
    {"eventType": "python.other", "payload": {"id": 2}},
    {"eventType": "bad type", "payload": {"id": 3}},
])
assert batch["results"][0]["ok"] is True
assert batch["results"][1]["ok"] is False
assert batch["results"][1]["error"]["code"] == "invalid_request"

try:
    client.create_endpoint("http://127.0.0.1/private")
    raise AssertionError("expected PosthornApiError")
except PosthornApiError as exc:
    assert exc.status == 400
    assert exc.code == "url_not_allowed"
    assert exc.body["error"]["code"] == "url_not_allowed"

print(json.dumps({"endpoint_id": created["endpoint"]["id"], "message_id": first["message"]["id"]}))
      `,
      { POSTHORN_URL: address.url, POSTHORN_API_KEY: TENANT_KEY },
    );

    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      fetch: async () => ({ status: 503 }),
    });

    await runPython(
      python,
      `
import os
from posthorn import PosthornClient

client = PosthornClient(os.environ["POSTHORN_URL"], os.environ["POSTHORN_API_KEY"])
endpoint_id = os.environ["ENDPOINT_ID"]
message_id = os.environ["MESSAGE_ID"]

message = client.get_message(message_id)
assert message["deliveries"][0]["status"] == "dead_letter"
assert message["deliveries"][0]["attemptCount"] == 1

attempts = client.list_message_attempts(message_id, limit=10)
assert attempts["nextCursor"] is None
assert attempts["data"][0]["messageId"] == message_id
assert attempts["data"][0]["failureReason"] == "http_503"
assert attempts["data"][0]["responseStatus"] == 503

endpoint_deliveries = client.list_endpoint_deliveries(endpoint_id, limit=5)
assert endpoint_deliveries["data"][0]["messageId"] == message_id
assert endpoint_deliveries["data"][0]["status"] == "dead_letter"

stats = client.get_endpoint_stats(endpoint_id, days=3)
assert stats["stats"]["total"] == 1
assert stats["stats"]["byStatus"]["dead_letter"] == 1
assert stats["stats"]["failureReasons"] == [{"reason": "http_503", "count": 1}]

deliveries = client.list_deliveries(
    status="dead_letter",
    endpoint_id=endpoint_id,
    event_type="python.created",
    failure_reason="http_503",
    limit=5,
)
assert deliveries["data"][0]["messageId"] == message_id
assert deliveries["nextCursor"] is None

usage = client.get_usage()
assert usage["usage"]["messagesAccepted"] == 2
assert usage["usage"]["deliveryAttempts"] == 1

retry = client.retry_message(message_id)
assert retry == {"retried": 1}
assert client.get_message(message_id)["deliveries"][0]["status"] == "pending"
      `,
      {
        POSTHORN_URL: address.url,
        POSTHORN_API_KEY: TENANT_KEY,
        ENDPOINT_ID: created.endpoint_id,
        MESSAGE_ID: created.message_id,
      },
    );
  });

  it('verifies Standard Webhooks signatures in Python', async () => {
    const python = findPython();

    await runPython(
      python,
      `
import base64
import hashlib
import hmac
from posthorn import WebhookVerificationError, verify_webhook

secret = "whsec_" + base64.b64encode(bytes(range(32))).decode("ascii")
body = b'{"ok":true}'
webhook_id = "msg_python"
timestamp = 1800000000
signed = f"{webhook_id}.{timestamp}.".encode("utf-8") + body
signature = base64.b64encode(hmac.new(bytes(range(32)), signed, hashlib.sha256).digest()).decode("ascii")
headers = {
    "Webhook-Id": webhook_id,
    "Webhook-Timestamp": str(timestamp),
    "Webhook-Signature": "v1," + base64.b64encode(b"wrong").decode("ascii") + " v1," + signature,
}

verified = verify_webhook(secret, headers, body, now=timestamp)
assert verified == {"id": webhook_id, "timestamp_seconds": timestamp}
verify_webhook(secret, headers, body.decode("utf-8"), now=timestamp)

try:
    verify_webhook(secret, headers, body, now=timestamp + 301)
    raise AssertionError("expected stale signature failure")
except WebhookVerificationError as exc:
    assert exc.code == "timestamp_outside_tolerance"

bad_headers = {
    "webhook-id": webhook_id,
    "webhook-timestamp": str(timestamp),
    "webhook-signature": "v1," + base64.b64encode(b"bad").decode("ascii"),
}
try:
    verify_webhook(secret, bad_headers, body, now=timestamp)
    raise AssertionError("expected signature mismatch")
except WebhookVerificationError as exc:
    assert exc.code == "signature_mismatch"

try:
    verify_webhook(secret, {"webhook-id": webhook_id}, body, now=timestamp)
    raise AssertionError("expected missing header")
except WebhookVerificationError as exc:
    assert exc.code == "missing_header"
      `,
      {},
    );
  });

  it('does not forward bearer tokens across API redirects', async () => {
    const python = findPython();
    let captureRequests = 0;
    let capturedAuthorization: string | undefined;
    const captureServer = createServer((request, response) => {
      captureRequests += 1;
      capturedAuthorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    const captureUrl = await listen(captureServer);
    const redirectServer = createServer((_request, response) => {
      response.writeHead(307, { location: `${captureUrl}/v1/endpoints` });
      response.end();
    });
    const redirectUrl = await listen(redirectServer);

    try {
      await runPython(
        python,
        `
from posthorn import PosthornApiError, PosthornClient

client = PosthornClient("${redirectUrl}", "phk_secret_redirect_test")
try:
    client.list_endpoints()
    raise AssertionError("expected redirect response to raise")
except PosthornApiError as exc:
    assert exc.status == 307
    assert exc.code == "http_error"
        `,
        {},
      );
      expect(captureRequests).toBe(0);
      expect(capturedAuthorization).toBeUndefined();
    } finally {
      await closeServer(redirectServer);
      await closeServer(captureServer);
    }
  });
});

async function startSeededGateway(): Promise<{ readonly address: GatewayAddress; readonly storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_python', 'Python Tenant', TENANT_KEY);
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
    },
    {
      openStorage: () => storage,
      now: () => NOW,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start(), storage };
}

function seedTenant(storage: PosthornStorage, appId: string, name: string, apiKey: string): void {
  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(appId, name, null, '2026-06-12T00:00:00.000Z');
  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`ak_${appId}`, appId, hashApiKey(apiKey), 'Python key', null, '2026-06-12T00:00:00.000Z');
}

function findPython(): string {
  for (const candidate of ['python', 'python3']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }

  throw new Error('Python SDK tests require python or python3 on PATH.');
}

async function runPythonJson<T>(python: string, script: string, env: Record<string, string>): Promise<T> {
  const output = await runPython(python, script, env);
  return JSON.parse(output.trim()) as T;
}

function runPython(python: string, script: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONPATH: path.resolve('clients/python'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) {
        reject(
          new Error(
            [
              `Python exited with status ${status}.`,
              stdout ? `stdout:\n${stdout}` : 'stdout: <empty>',
              stderr ? `stderr:\n${stderr}` : 'stderr: <empty>',
            ].join('\n'),
          ),
        );
        return;
      }

      resolve(stdout);
    });
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Expected TCP server address.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
