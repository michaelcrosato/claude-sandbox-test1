import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createGateway,
  hashApiKey,
  loadConfig,
  openStorage,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_A_KEY = `phk_${Buffer.alloc(32, 1).toString('base64url')}`;
const TENANT_B_KEY = `phk_${Buffer.alloc(32, 2).toString('base64url')}`;
const REVOKED_KEY = `phk_${Buffer.alloc(32, 3).toString('base64url')}`;

const activeGateways: Gateway[] = [];

interface EndpointJson {
  readonly id: string;
  readonly url: string;
  readonly eventTypes: readonly string[] | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly rateLimitPerSecond: number | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EndpointCreateJson {
  readonly endpoint: EndpointJson;
  readonly secret: string;
}

interface EndpointRotateJson {
  readonly endpoint: EndpointJson;
  readonly secret: string;
  readonly previousSecretExpiresAt: string;
}

interface EndpointReadJson {
  readonly endpoint: EndpointJson;
}

interface EndpointListJson {
  readonly data: readonly EndpointJson[];
}

interface ErrorJson {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (gateway !== undefined) {
      await gateway.stop();
    }
  }
});

describe('endpoint management HTTP routes', () => {
  it('creates endpoints with event filters, optional headers, and a signing secret returned once', async () => {
    const { address, storage } = await startSeededGateway();

    const createResponse = await requestJson<EndpointCreateJson>(address, 'POST', '/v1/endpoints', TENANT_A_KEY, {
      url: 'https://example.com/webhooks/users',
      eventTypes: ['user.created', 'user.deleted'],
      headers: { 'X-Trace-Id': 'tenant-a' },
      rateLimitPerSecond: 5,
    });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toMatchObject({
      endpoint: {
        url: 'https://example.com/webhooks/users',
        eventTypes: ['user.created', 'user.deleted'],
        headers: { 'X-Trace-Id': 'tenant-a' },
        rateLimitPerSecond: 5,
        enabled: true,
      },
    });
    expect(createResponse.body.endpoint.id).toMatch(/^ep_/);
    expect(createResponse.body.endpoint).not.toHaveProperty('secret');
    expect(createResponse.body.secret).toMatch(/^whsec_/);

    const persisted = storage.db
      .prepare(
        'SELECT signing_secret_ciphertext, signing_secret_key_version, signing_secret_nonce, rate_limit_per_second FROM endpoints WHERE id = ?',
      )
      .get(createResponse.body.endpoint.id) as {
      signing_secret_ciphertext: string;
      signing_secret_key_version: string;
      signing_secret_nonce: string;
      rate_limit_per_second: number;
    };
    expect(persisted.signing_secret_ciphertext).toMatch(/^sha256:/);
    expect(persisted.signing_secret_key_version).toBe('local-aes-256-gcm-v1');
    expect(persisted.signing_secret_nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(persisted.signing_secret_ciphertext).not.toContain(createResponse.body.secret);
    expect(persisted.rate_limit_per_second).toBe(5);

    const getResponse = await requestJson<EndpointReadJson>(
      address,
      'GET',
      `/v1/endpoints/${createResponse.body.endpoint.id}`,
      TENANT_A_KEY,
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.endpoint).not.toHaveProperty('secret');
    expect(JSON.stringify(getResponse.body)).not.toContain(createResponse.body.secret);
  });

  it('lists, fetches, updates, and deletes only the authenticated tenant endpoints', async () => {
    const { address } = await startSeededGateway();
    const first = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/first',
      eventTypes: ['invoice.paid'],
      rateLimitPerSecond: 2,
    });
    const second = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/second',
      headers: { 'X-Environment': 'test' },
    });

    const listResponse = await requestJson<EndpointListJson>(address, 'GET', '/v1/endpoints', TENANT_A_KEY);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.map((endpoint) => endpoint.id).sort()).toEqual([first.endpoint.id, second.endpoint.id].sort());

    const patchResponse = await requestJson<EndpointReadJson>(
      address,
      'PATCH',
      `/v1/endpoints/${first.endpoint.id}`,
      TENANT_A_KEY,
      {
        url: 'https://example.com/hooks/renamed',
        eventTypes: null,
        headers: { 'X-Trace-Id': 'updated' },
        rateLimitPerSecond: 3,
        enabled: false,
      },
    );
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.endpoint).toMatchObject({
      id: first.endpoint.id,
      url: 'https://example.com/hooks/renamed',
      eventTypes: null,
      headers: { 'X-Trace-Id': 'updated' },
      rateLimitPerSecond: 3,
      enabled: false,
    });

    const clearRateLimit = await requestJson<EndpointReadJson>(
      address,
      'PATCH',
      `/v1/endpoints/${first.endpoint.id}`,
      TENANT_A_KEY,
      { rateLimitPerSecond: null },
    );
    expect(clearRateLimit.status).toBe(200);
    expect(clearRateLimit.body.endpoint.rateLimitPerSecond).toBeNull();

    const deleteResponse = await requestRaw(address, 'DELETE', `/v1/endpoints/${second.endpoint.id}`, TENANT_A_KEY);
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe('');

    const afterDelete = await requestJson<EndpointListJson>(address, 'GET', '/v1/endpoints', TENANT_A_KEY);
    expect(afterDelete.body.data.map((endpoint) => endpoint.id)).toEqual([first.endpoint.id]);
  });

  it('enforces tenant isolation across list, fetch, update, and delete', async () => {
    const { address } = await startSeededGateway();
    const created = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/private',
      eventTypes: ['tenant.private'],
    });

    const tenantBList = await requestJson<EndpointListJson>(address, 'GET', '/v1/endpoints', TENANT_B_KEY);
    expect(tenantBList.status).toBe(200);
    expect(tenantBList.body.data).toEqual([]);

    const tenantBGet = await requestJson<ErrorJson>(address, 'GET', `/v1/endpoints/${created.endpoint.id}`, TENANT_B_KEY);
    expect(tenantBGet.status).toBe(404);

    const tenantBPatch = await requestJson<ErrorJson>(
      address,
      'PATCH',
      `/v1/endpoints/${created.endpoint.id}`,
      TENANT_B_KEY,
      {
        enabled: false,
      },
    );
    expect(tenantBPatch.status).toBe(404);

    const tenantBDelete = await requestJson<ErrorJson>(
      address,
      'DELETE',
      `/v1/endpoints/${created.endpoint.id}`,
      TENANT_B_KEY,
    );
    expect(tenantBDelete.status).toBe(404);

    const tenantAGet = await requestJson<EndpointReadJson>(
      address,
      'GET',
      `/v1/endpoints/${created.endpoint.id}`,
      TENANT_A_KEY,
    );
    expect(tenantAGet.status).toBe(200);
  });

  it('rotates endpoint signing secrets once and preserves the previous secret for overlap signing', async () => {
    const rotationNow = new Date('2026-06-12T12:30:00.000Z');
    const { address, storage } = await startSeededGateway({ now: () => rotationNow });
    const created = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/rotate',
      headers: { 'X-Trace-Id': 'rotate' },
    });
    const before = readEndpointSecretColumns(storage, created.endpoint.id);

    const rotated = await requestJson<EndpointRotateJson>(
      address,
      'POST',
      `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
      TENANT_A_KEY,
      { overlapSeconds: 120 },
    );

    expect(rotated.status).toBe(201);
    expect(rotated.body.endpoint).toMatchObject({
      id: created.endpoint.id,
      url: created.endpoint.url,
      headers: { 'X-Trace-Id': 'rotate' },
      enabled: true,
    });
    expect(rotated.body.endpoint).not.toHaveProperty('secret');
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(created.secret);
    expect(rotated.body.previousSecretExpiresAt).toBe('2026-06-12T12:32:00.000Z');

    const after = readEndpointSecretColumns(storage, created.endpoint.id);
    expect(after.signing_secret_ciphertext).not.toBe(before.signing_secret_ciphertext);
    expect(after.signing_secret_key_version).toBe('local-aes-256-gcm-v1');
    expect(after.signing_secret_ciphertext).not.toContain(rotated.body.secret);
    expect(after.previous_signing_secret_ciphertext).toBe(before.signing_secret_ciphertext);
    expect(after.previous_signing_secret_key_version).toBe(before.signing_secret_key_version);
    expect(after.previous_signing_secret_nonce).toBe(before.signing_secret_nonce);
    expect(after.previous_signing_secret_expires_at).toBe('2026-06-12T12:32:00.000Z');

    const readResponse = await requestJson<EndpointReadJson>(
      address,
      'GET',
      `/v1/endpoints/${created.endpoint.id}`,
      TENANT_A_KEY,
    );
    const listResponse = await requestJson<EndpointListJson>(address, 'GET', '/v1/endpoints', TENANT_A_KEY);
    expect(JSON.stringify(readResponse.body)).not.toContain(created.secret);
    expect(JSON.stringify(readResponse.body)).not.toContain(rotated.body.secret);
    expect(JSON.stringify(listResponse.body)).not.toContain(created.secret);
    expect(JSON.stringify(listResponse.body)).not.toContain(rotated.body.secret);
  });

  it('keeps rotation tenant-scoped and allows disabled endpoint credential rotation', async () => {
    const rotationNow = new Date('2026-06-12T15:00:00.000Z');
    const { address } = await startSeededGateway({ now: () => rotationNow });
    const created = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/rotate-auth',
    });
    const disabled = await requestJson<EndpointReadJson>(
      address,
      'PATCH',
      `/v1/endpoints/${created.endpoint.id}`,
      TENANT_A_KEY,
      { enabled: false },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.endpoint.enabled).toBe(false);

    const tenantBRotate = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
      TENANT_B_KEY,
      {},
    );
    expect(tenantBRotate.status).toBe(404);

    const tenantBInvalidRotate = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
      TENANT_B_KEY,
      { overlapSeconds: 59 },
    );
    expect(tenantBInvalidRotate.status).toBe(404);

    const missingAuth = await fetch(`${address.url}/v1/endpoints/${created.endpoint.id}/rotate-secret`, {
      method: 'POST',
    });
    expect(missingAuth.status).toBe(401);

    const revokedAuth = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
      REVOKED_KEY,
      {},
    );
    expect(revokedAuth.status).toBe(401);

    const wrongMethod = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
      TENANT_A_KEY,
    );
    expect(wrongMethod.status).toBe(405);

    const rotatedDisabled = await requestJson<EndpointRotateJson>(
      address,
      'POST',
      `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
      TENANT_A_KEY,
    );
    expect(rotatedDisabled.status).toBe(201);
    expect(rotatedDisabled.body.endpoint.enabled).toBe(false);
    expect(rotatedDisabled.body.previousSecretExpiresAt).toBe('2026-06-13T15:00:00.000Z');
    expect(rotatedDisabled.body.secret).toMatch(/^whsec_/);
  });

  it('validates rotation overlap bounds', async () => {
    const { address } = await startSeededGateway();
    const created = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/rotate-validation',
    });

    for (const body of [
      { overlapSeconds: 59 },
      { overlapSeconds: 2_592_001 },
      { overlapSeconds: 1.5 },
      { overlapSeconds: '60' },
      null,
      [],
    ]) {
      const response = await requestJson<ErrorJson>(
        address,
        'POST',
        `/v1/endpoints/${created.endpoint.id}/rotate-secret`,
        TENANT_A_KEY,
        body,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_request');
    }
  });

  it('rejects missing auth, revoked keys, malformed JSON, and invalid endpoint input', async () => {
    const { address } = await startSeededGateway();

    const missingAuth = await fetch(`${address.url}/v1/endpoints`);
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      error: { code: 'unauthorized', message: 'Invalid bearer token.' },
    });

    const revokedAuth = await requestJson<ErrorJson>(address, 'GET', '/v1/endpoints', REVOKED_KEY);
    expect(revokedAuth.status).toBe(401);

    const malformedJson = await fetch(`${address.url}/v1/endpoints`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TENANT_A_KEY}`,
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    expect(await malformedJson.json()).toEqual({
      error: { code: 'invalid_json', message: 'Request body must be valid JSON.' },
    });

    await expectEndpointError(address, { url: 'ftp://example.com/hook' }, 'invalid_request');
    await expectEndpointError(address, { url: 'http://127.0.0.1/hook' }, 'url_not_allowed');
    await expectEndpointError(address, { url: 'http://localhost./hook' }, 'url_not_allowed');
    await expectEndpointError(address, { url: 'http://foo.localhost./hook' }, 'url_not_allowed');
    await expectEndpointError(address, { url: 'http://svc.local./hook' }, 'url_not_allowed');
    await expectEndpointError(address, { url: 'http://svc.internal./hook' }, 'url_not_allowed');
    await expectEndpointError(address, { url: 'http://[fe90::1]/hook' }, 'url_not_allowed');
    await expectEndpointError(address, { url: 'http://[ff00::1]/hook' }, 'url_not_allowed');
    await expectEndpointError(
      address,
      { url: 'https://example.com/hook', eventTypes: ['bad type'] },
      'invalid_request',
    );
    await expectEndpointError(
      address,
      { url: 'https://example.com/hook', headers: { Authorization: 'secret' } },
      'invalid_request',
    );
    for (const rateLimitPerSecond of [0, -1, 1.5, '1', false]) {
      await expectEndpointError(
        address,
        { url: 'https://example.com/hook', rateLimitPerSecond },
        'invalid_request',
      );
    }

    const valid = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/update-validation',
    });
    for (const rateLimitPerSecond of [0, -1, 1.5, '1', false]) {
      const response = await requestJson<ErrorJson>(
        address,
        'PATCH',
        `/v1/endpoints/${valid.endpoint.id}`,
        TENANT_A_KEY,
        { rateLimitPerSecond },
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_request');
    }
  });

  it('hides deleted endpoints from future reads and lists', async () => {
    const { address } = await startSeededGateway();
    const created = await createEndpoint(address, TENANT_A_KEY, {
      url: 'https://example.com/hooks/delete-me',
    });

    const deleted = await requestRaw(address, 'DELETE', `/v1/endpoints/${created.endpoint.id}`, TENANT_A_KEY);
    expect(deleted.status).toBe(204);

    const getDeleted = await requestJson<ErrorJson>(address, 'GET', `/v1/endpoints/${created.endpoint.id}`, TENANT_A_KEY);
    expect(getDeleted.status).toBe(404);

    const listDeleted = await requestJson<EndpointListJson>(address, 'GET', '/v1/endpoints', TENANT_A_KEY);
    expect(listDeleted.status).toBe(200);
    expect(listDeleted.body.data).toEqual([]);
  });

  it('returns 413 when a request body crosses the configured maximum before the request ends', async () => {
    const { address } = await startSeededGateway({ maxBodyBytes: 8 });

    const rawResponse = await sendPartialRawRequest(
      address.port,
      [
        'POST /v1/endpoints HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${TENANT_A_KEY}`,
        'Content-Type: application/json',
        'Content-Length: 1000000',
        'Connection: close',
        '',
        '{"url":"https://example.com/hook"',
      ].join('\r\n'),
    );

    expect(rawResponse).toContain('HTTP/1.1 413 Payload Too Large');
    expect(rawResponse).toContain('"code":"payload_too_large"');
  });
});

async function startSeededGateway(
  options: { readonly maxBodyBytes?: number; readonly now?: () => Date } = {},
): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_a', 'Tenant A', TENANT_A_KEY);
  seedTenant(storage, 'app_b', 'Tenant B', TENANT_B_KEY);
  seedTenant(storage, 'app_revoked', 'Revoked Tenant', REVOKED_KEY, '2026-06-12T00:00:00.000Z');

  const gateway = createGateway(
    {
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 0,
      maxBodyBytes: options.maxBodyBytes,
    },
    {
      openStorage: () => storage,
      now: options.now,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start(), storage };
}

function readEndpointSecretColumns(
  storage: PosthornStorage,
  endpointId: string,
): {
  readonly signing_secret_ciphertext: string;
  readonly signing_secret_key_version: string;
  readonly signing_secret_nonce: string;
  readonly previous_signing_secret_ciphertext: string | null;
  readonly previous_signing_secret_key_version: string | null;
  readonly previous_signing_secret_nonce: string | null;
  readonly previous_signing_secret_expires_at: string | null;
} {
  return storage.db
    .prepare(
      `
        SELECT signing_secret_ciphertext,
               signing_secret_key_version,
               signing_secret_nonce,
               previous_signing_secret_ciphertext,
               previous_signing_secret_key_version,
               previous_signing_secret_nonce,
               previous_signing_secret_expires_at
        FROM endpoints
        WHERE id = ?
      `,
    )
    .get(endpointId) as {
    readonly signing_secret_ciphertext: string;
    readonly signing_secret_key_version: string;
    readonly signing_secret_nonce: string;
    readonly previous_signing_secret_ciphertext: string | null;
    readonly previous_signing_secret_key_version: string | null;
    readonly previous_signing_secret_nonce: string | null;
    readonly previous_signing_secret_expires_at: string | null;
  };
}

function seedTenant(
  storage: PosthornStorage,
  appId: string,
  name: string,
  apiKey: string,
  revokedAt: string | null = null,
): void {
  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(appId, name, null, '2026-06-12T00:00:00.000Z');
  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      `ak_${appId}`,
      appId,
      hashApiKey(apiKey),
      'Test key',
      revokedAt,
      '2026-06-12T00:00:00.000Z',
    );
}

async function createEndpoint(
  address: GatewayAddress,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<EndpointCreateJson> {
  const response = await requestJson<EndpointCreateJson>(address, 'POST', '/v1/endpoints', apiKey, body);
  expect(response.status).toBe(201);
  return response.body;
}

async function expectEndpointError(
  address: GatewayAddress,
  body: Record<string, unknown>,
  code: 'invalid_request' | 'url_not_allowed',
): Promise<void> {
  const response = await requestJson<ErrorJson>(address, 'POST', '/v1/endpoints', TENANT_A_KEY, body);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe(code);
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await requestRaw(address, method, path, apiKey, body);
  return {
    status: response.status,
    body: (response.status === 204 ? null : await response.json()) as T,
  };
}

function requestRaw(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sendPartialRawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(payload);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      settleWithError(new Error('Timed out waiting for response.'));
    }, 1_000);

    const settle = (response: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const settleWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      settle(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', settleWithError);
  });
}
