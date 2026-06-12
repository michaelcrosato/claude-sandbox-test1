import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { POSTHORN_DATABASE_FILE, startPosthornServer, type PosthornServer } from '../src/index';

const ADMIN_TOKEN = '0123456789abcdef0123456789abcdef';
const activeServers: PosthornServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server !== undefined) {
      await server.stop();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('production server entrypoint', () => {
  it('starts the gateway and in-process worker on one file-backed store', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'posthorn-server-'));
    tempDirs.push(dataDir);
    const deliveredBodies: string[] = [];

    const server = await startPosthornServer(
      {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        maxBodyBytes: 1_000_000,
        adminToken: ADMIN_TOKEN,
        endpointAutoDisableAfterMs: 432_000_000,
        worker: {
          batchSize: 4,
          concurrency: 1,
          requestTimeoutMs: 1_000,
          idlePollMs: 10,
          visibilityTimeoutMs: 1_000,
          attemptBudget: 2,
        },
      },
      {
        fetch: async (_url, init) => {
          deliveredBodies.push(init.body);
          return new Response(null, { status: 204 });
        },
      },
    );
    activeServers.push(server);

    const health = await fetch(`${server.address.url}/healthz`);
    expect(health.status).toBe(200);
    expect(existsSync(join(dataDir, POSTHORN_DATABASE_FILE))).toBe(true);

    const app = await requestJson<{ readonly app: { readonly id: string } }>(server, 'POST', '/v1/admin/apps', {
      name: 'Docker Tenant',
    });
    const key = await requestJson<{ readonly secret: string }>(
      server,
      'POST',
      `/v1/admin/apps/${app.app.id}/keys`,
      {},
    );
    await requestJson(server, 'POST', '/v1/endpoints', {
      url: 'https://example.com/webhooks/posthorn',
      eventTypes: ['server.created'],
    }, key.secret);
    const sent = await requestJson<{ readonly message: { readonly id: string } }>(
      server,
      'POST',
      '/v1/messages',
      { eventType: 'server.created', payload: { id: 42 } },
      key.secret,
    );

    await waitFor(async () => {
      const status = await requestJson<{ readonly deliveries: ReadonlyArray<{ readonly status: string }> }>(
        server,
        'GET',
        `/v1/messages/${sent.message.id}`,
        undefined,
        key.secret,
      );
      return status.deliveries.some((delivery) => delivery.status === 'succeeded');
    });

    expect(deliveredBodies).toHaveLength(1);
    expect(JSON.parse(deliveredBodies[0])).toEqual({
      id: sent.message.id,
      eventType: 'server.created',
      payload: { id: 42 },
    });
  });
});

async function requestJson<T>(
  server: PosthornServer,
  method: string,
  path: string,
  body?: unknown,
  token = ADMIN_TOKEN,
): Promise<T> {
  const response = await fetch(`${server.address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBeLessThan(400);
  return (await response.json()) as T;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await predicate()).toBe(true);
}
