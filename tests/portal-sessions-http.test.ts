import { afterEach, describe, expect, it } from 'vitest';

import {
  createEndpoint,
  createGateway,
  getPortalSessionByToken,
  hashApiKey,
  loadConfig,
  openStorage,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 71).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 72).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

const activeGateways: Gateway[] = [];

interface PortalSessionJson {
  readonly session: {
    readonly id: string;
    readonly appId: string;
    readonly token: string;
    readonly scope: string;
    readonly endpointId: string | null;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
  };
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

describe('portal session HTTP route', () => {
  it('creates short-lived endpoint-management sessions and stores only token hashes', async () => {
    const { address, storage, endpointId } = await startSeededGateway();

    const created = await requestJson<PortalSessionJson>(address, 'POST', '/v1/portal/sessions', TENANT_KEY, {
      endpointId,
      expiresInSeconds: 120,
    });

    expect(created.status).toBe(201);
    expect(created.body.session).toEqual({
      id: expect.stringMatching(/^ps_/),
      appId: 'app_portal',
      token: expect.stringMatching(/^phs_/),
      scope: 'endpoint_management',
      endpointId,
      expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
      createdAt: NOW.toISOString(),
      revokedAt: null,
    });

    const persisted = storage.db
      .prepare('SELECT token_hash FROM portal_sessions WHERE id = ?')
      .get(created.body.session.id) as { readonly token_hash: unknown };
    expect(String(persisted.token_hash)).toMatch(/^sha256:/);
    expect(String(persisted.token_hash)).not.toContain(created.body.session.token);

    expect(getPortalSessionByToken(storage, created.body.session.token, NOW)).toEqual({
      id: created.body.session.id,
      appId: 'app_portal',
      scope: 'endpoint_management',
      endpointId,
      expiresAt: created.body.session.expiresAt,
      createdAt: NOW.toISOString(),
      revokedAt: null,
    });
    expect(getPortalSessionByToken(storage, created.body.session.token, new Date(NOW.getTime() + 120_000))).toBeNull();
  });

  it('supports a default session body and validates TTL and endpoint scope', async () => {
    const { address, endpointId } = await startSeededGateway();

    const defaultSession = await requestJson<PortalSessionJson>(address, 'POST', '/v1/portal/sessions', TENANT_KEY);
    expect(defaultSession.status).toBe(201);
    expect(defaultSession.body.session).toMatchObject({
      appId: 'app_portal',
      endpointId: null,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    });

    const shortTtl = await requestJson<ErrorJson>(address, 'POST', '/v1/portal/sessions', TENANT_KEY, {
      expiresInSeconds: 59,
    });
    expect(shortTtl.status).toBe(400);
    expect(shortTtl.body.error.code).toBe('invalid_request');

    const otherTenantEndpoint = await requestJson<ErrorJson>(address, 'POST', '/v1/portal/sessions', OTHER_TENANT_KEY, {
      endpointId,
    });
    expect(otherTenantEndpoint.status).toBe(404);
  });
});

async function startSeededGateway(): Promise<{ address: GatewayAddress; storage: PosthornStorage; endpointId: string }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_portal', 'Portal Tenant', TENANT_KEY);
  seedTenant(storage, 'app_other', 'Other Tenant', OTHER_TENANT_KEY);
  const endpoint = createEndpoint(storage, 'app_portal', {
    url: 'https://example.com/hooks/portal',
  }, NOW).endpoint;
  const gateway = createGateway(
    {
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 0,
    },
    {
      openStorage: () => storage,
      now: () => NOW,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start(), storage, endpointId: endpoint.id };
}

function seedTenant(storage: PosthornStorage, appId: string, name: string, apiKey: string): void {
  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(appId, name, null, '2026-06-12T00:00:00.000Z');
  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`ak_${appId}`, appId, hashApiKey(apiKey), 'Test key', null, '2026-06-12T00:00:00.000Z');
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}
