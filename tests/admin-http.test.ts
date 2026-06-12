import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, loadConfig, openStorage, type Gateway, type GatewayAddress, type PosthornStorage } from '../src/index';

const ADMIN_TOKEN = '0123456789abcdef';

const activeGateways: Gateway[] = [];

interface AppJson {
  readonly id: string;
  readonly name: string;
  readonly monthlyMessageQuota: number | null;
  readonly createdAt: string;
}

interface ApiKeyJson {
  readonly id: string;
  readonly appId: string;
  readonly name: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

interface AppReadJson {
  readonly app: AppJson;
}

interface AppListJson {
  readonly data: readonly AppJson[];
}

interface ApiKeyCreateJson {
  readonly apiKey: ApiKeyJson;
  readonly secret: string;
}

interface ApiKeyListJson {
  readonly data: readonly ApiKeyJson[];
}

interface SystemSecretRotateJson {
  readonly app: AppJson;
  readonly secret: string;
  readonly previousSecretExpiresAt: string | null;
}

interface EndpointListJson {
  readonly data: readonly unknown[];
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

describe('admin HTTP routes', () => {
  it('returns 404 for admin routes when the admin token is not configured', async () => {
    const { address } = await startGateway();

    const list = await requestJson<ErrorJson>(address, 'GET', '/v1/admin/apps', ADMIN_TOKEN);
    const nested = await requestJson<ErrorJson>(address, 'POST', '/v1/admin/apps/app_missing/keys', ADMIN_TOKEN, {});
    const rotate = await requestJson<ErrorJson>(
      address,
      'POST',
      '/v1/admin/apps/app_missing/rotate-system-secret',
      ADMIN_TOKEN,
      {},
    );

    expect(list.status).toBe(404);
    expect(list.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect(nested.status).toBe(404);
    expect(nested.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect(rotate.status).toBe(404);
    expect(rotate.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('rejects missing and invalid admin tokens when admin routes are enabled', async () => {
    const { address } = await startGateway({ adminToken: ADMIN_TOKEN });

    const missing = await fetch(`${address.url}/v1/admin/apps`);
    const invalid = await requestJson<ErrorJson>(address, 'GET', '/v1/admin/apps', 'wrong-admin-token');
    const invalidUnsupportedMethod = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/admin/apps/app_missing/rotate-system-secret',
      'wrong-admin-token',
    );
    const validUnsupportedMethod = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/admin/apps/app_missing/rotate-system-secret',
      ADMIN_TOKEN,
    );

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid bearer token.' } });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ error: { code: 'unauthorized', message: 'Invalid bearer token.' } });
    expect(invalidUnsupportedMethod.status).toBe(401);
    expect(invalidUnsupportedMethod.body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid bearer token.' },
    });
    expect(validUnsupportedMethod.status).toBe(405);
    expect(validUnsupportedMethod.body).toEqual({
      error: { code: 'method_not_allowed', message: 'Method not allowed.' },
    });
  });

  it('creates, lists, reads, updates, and deletes tenant apps', async () => {
    const { address } = await startGateway({ adminToken: ADMIN_TOKEN });

    const created = await requestJson<AppReadJson>(address, 'POST', '/v1/admin/apps', ADMIN_TOKEN, {
      name: ' Acme ',
      monthlyMessageQuota: 1000,
    });
    expect(created.status).toBe(201);
    expect(created.body.app).toMatchObject({
      id: expect.stringMatching(/^app_/),
      name: 'Acme',
      monthlyMessageQuota: 1000,
      createdAt: expect.any(String),
    });

    const listed = await requestJson<AppListJson>(address, 'GET', '/v1/admin/apps', ADMIN_TOKEN);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([created.body.app]);

    const read = await requestJson<AppReadJson>(address, 'GET', `/v1/admin/apps/${created.body.app.id}`, ADMIN_TOKEN);
    expect(read.status).toBe(200);
    expect(read.body.app).toEqual(created.body.app);

    const updated = await requestJson<AppReadJson>(address, 'PATCH', `/v1/admin/apps/${created.body.app.id}`, ADMIN_TOKEN, {
      name: 'Acme Enterprise',
      monthlyMessageQuota: null,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.app).toEqual({
      ...created.body.app,
      name: 'Acme Enterprise',
      monthlyMessageQuota: null,
    });

    const deleted = await requestRaw(address, 'DELETE', `/v1/admin/apps/${created.body.app.id}`, ADMIN_TOKEN);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    const missing = await requestJson<ErrorJson>(address, 'GET', `/v1/admin/apps/${created.body.app.id}`, ADMIN_TOKEN);
    expect(missing.status).toBe(404);
    const afterDelete = await requestJson<AppListJson>(address, 'GET', '/v1/admin/apps', ADMIN_TOKEN);
    expect(afterDelete.body.data).toEqual([]);
  });

  it('mints, lists, and revokes tenant API keys without exposing reusable key material', async () => {
    const { address } = await startGateway({ adminToken: ADMIN_TOKEN });
    const created = await requestJson<AppReadJson>(address, 'POST', '/v1/admin/apps', ADMIN_TOKEN, {
      name: 'Key Tenant',
    });

    const key = await requestJson<ApiKeyCreateJson>(
      address,
      'POST',
      `/v1/admin/apps/${created.body.app.id}/keys`,
      ADMIN_TOKEN,
      { name: 'Primary key' },
    );
    expect(key.status).toBe(201);
    expect(key.body.secret).toMatch(/^phk_/);
    expect(key.body.apiKey).toMatchObject({
      id: expect.stringMatching(/^ak_/),
      appId: created.body.app.id,
      name: 'Primary key',
      revokedAt: null,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(key.body.apiKey)).not.toContain(key.body.secret);

    const keys = await requestJson<ApiKeyListJson>(address, 'GET', `/v1/admin/apps/${created.body.app.id}/keys`, ADMIN_TOKEN);
    expect(keys.status).toBe(200);
    expect(keys.body.data).toEqual([key.body.apiKey]);
    expect(JSON.stringify(keys.body)).not.toContain(key.body.secret);
    expect(JSON.stringify(keys.body)).not.toContain('sha256:');

    const tenantAuthBeforeRevoke = await requestJson<EndpointListJson>(address, 'GET', '/v1/endpoints', key.body.secret);
    expect(tenantAuthBeforeRevoke.status).toBe(200);
    expect(tenantAuthBeforeRevoke.body).toEqual({ data: [] });

    const revoked = await requestRaw(address, 'DELETE', `/v1/admin/keys/${key.body.apiKey.id}`, ADMIN_TOKEN);
    expect(revoked.status).toBe(204);

    const afterRevoke = await requestJson<ApiKeyListJson>(
      address,
      'GET',
      `/v1/admin/apps/${created.body.app.id}/keys`,
      ADMIN_TOKEN,
    );
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body.data).toEqual([
      {
        ...key.body.apiKey,
        revokedAt: expect.any(String),
      },
    ]);

    const tenantAuthAfterRevoke = await requestJson<ErrorJson>(address, 'GET', '/v1/endpoints', key.body.secret);
    expect(tenantAuthAfterRevoke.status).toBe(401);
    expect(tenantAuthAfterRevoke.body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid bearer token.' },
    });
  });

  it('rotates app system signing secrets with protected storage and one-time secret output', async () => {
    const { address, storage } = await startGateway({ adminToken: ADMIN_TOKEN });
    const created = await requestJson<AppReadJson>(address, 'POST', '/v1/admin/apps', ADMIN_TOKEN, {
      name: 'System Secret Tenant',
    });

    const missing = await requestJson<ErrorJson>(
      address,
      'POST',
      '/v1/admin/apps/app_missing/rotate-system-secret',
      ADMIN_TOKEN,
      {},
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });

    const first = await requestJson<SystemSecretRotateJson>(
      address,
      'POST',
      `/v1/admin/apps/${created.body.app.id}/rotate-system-secret`,
      ADMIN_TOKEN,
      {},
    );
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      app: created.body.app,
      secret: expect.stringMatching(/^whsec_/),
      previousSecretExpiresAt: null,
    });
    const afterFirst = readSystemSecretRow(storage, created.body.app.id);
    expect(afterFirst.system_signing_secret_ciphertext).toMatch(/^sha256:/);
    expect(afterFirst.system_signing_secret_ciphertext).not.toContain(first.body.secret);
    expect(afterFirst.system_signing_secret_key_version).toBe('local-aes-256-gcm-v1');
    expect(afterFirst.system_signing_secret_nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(afterFirst.previous_system_signing_secret_ciphertext).toBeNull();

    const second = await requestJson<SystemSecretRotateJson>(
      address,
      'POST',
      `/v1/admin/apps/${created.body.app.id}/rotate-system-secret`,
      ADMIN_TOKEN,
      { overlapSeconds: 120 },
    );
    expect(second.status).toBe(201);
    expect(second.body).toEqual({
      app: created.body.app,
      secret: expect.stringMatching(/^whsec_/),
      previousSecretExpiresAt: expect.any(String),
    });
    expect(second.body.secret).not.toBe(first.body.secret);
    const afterSecond = readSystemSecretRow(storage, created.body.app.id);
    expect(afterSecond.system_signing_secret_ciphertext).not.toBe(afterFirst.system_signing_secret_ciphertext);
    expect(afterSecond.previous_system_signing_secret_ciphertext).toBe(afterFirst.system_signing_secret_ciphertext);
    expect(afterSecond.previous_system_signing_secret_key_version).toBe(afterFirst.system_signing_secret_key_version);
    expect(afterSecond.previous_system_signing_secret_nonce).toBe(afterFirst.system_signing_secret_nonce);
    expect(afterSecond.previous_system_signing_secret_expires_at).toBe(second.body.previousSecretExpiresAt);

    const read = await requestJson<AppReadJson>(address, 'GET', `/v1/admin/apps/${created.body.app.id}`, ADMIN_TOKEN);
    const listed = await requestJson<AppListJson>(address, 'GET', '/v1/admin/apps', ADMIN_TOKEN);
    const updated = await requestJson<AppReadJson>(
      address,
      'PATCH',
      `/v1/admin/apps/${created.body.app.id}`,
      ADMIN_TOKEN,
      { name: 'System Secret Tenant Updated' },
    );
    const serialized = JSON.stringify([read.body, listed.body, updated.body]);
    expect(serialized).not.toContain(first.body.secret);
    expect(serialized).not.toContain(second.body.secret);
    expect(serialized).not.toContain('sha256:');
    expect(serialized).not.toContain('system_signing_secret');
    expect(serialized).not.toContain('nonce');
    expect(serialized).not.toContain('local-aes-256-gcm-v1');

    const invalidOverlap = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/admin/apps/${created.body.app.id}/rotate-system-secret`,
      ADMIN_TOKEN,
      { overlapSeconds: 59 },
    );
    expect(invalidOverlap.status).toBe(400);
    expect(invalidOverlap.body.error.code).toBe('invalid_request');
  });
});

async function startGateway(
  options: { readonly adminToken?: string } = {},
): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  const gateway = createGateway(
    {
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
        ...(options.adminToken === undefined ? {} : { POSTHORN_ADMIN_TOKEN: options.adminToken }),
      }),
      port: 0,
    },
    {
      openStorage: () => storage,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start(), storage };
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await requestRaw(address, method, path, token, body);
  return {
    status: response.status,
    body: (response.status === 204 ? null : await response.json()) as T,
  };
}

function requestRaw(
  address: GatewayAddress,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function readSystemSecretRow(storage: PosthornStorage, appId: string): SystemSecretRow {
  const row = storage.db
    .prepare(
      `
        SELECT system_signing_secret_ciphertext,
               system_signing_secret_key_version,
               system_signing_secret_nonce,
               previous_system_signing_secret_ciphertext,
               previous_system_signing_secret_key_version,
               previous_system_signing_secret_nonce,
               previous_system_signing_secret_expires_at
        FROM apps
        WHERE id = ?
      `,
    )
    .get(appId) as SystemSecretRow | undefined;
  if (row === undefined) throw new Error(`Missing app ${appId}.`);
  return row;
}

interface SystemSecretRow {
  readonly system_signing_secret_ciphertext: string | null;
  readonly system_signing_secret_key_version: string | null;
  readonly system_signing_secret_nonce: string | null;
  readonly previous_system_signing_secret_ciphertext: string | null;
  readonly previous_system_signing_secret_key_version: string | null;
  readonly previous_system_signing_secret_nonce: string | null;
  readonly previous_system_signing_secret_expires_at: string | null;
}
