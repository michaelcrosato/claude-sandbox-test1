import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, hashApiKey, loadConfig, openStorage, type Gateway, type GatewayAddress, type PosthornStorage } from '../src/index';

const TENANT_A_KEY = `phk_${Buffer.alloc(32, 51).toString('base64url')}`;
const TENANT_B_KEY = `phk_${Buffer.alloc(32, 52).toString('base64url')}`;

const activeGateways: Gateway[] = [];

interface EventTypeJson {
  readonly id: string;
  readonly eventType: string;
  readonly description: string | null;
  readonly schemaExample: unknown;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EventTypeReadJson {
  readonly eventType: EventTypeJson;
}

interface EventTypeListJson {
  readonly data: readonly EventTypeJson[];
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

describe('event type catalog HTTP routes', () => {
  it('creates, lists, reads, updates, archives, and recreates active event types', async () => {
    const { address } = await startSeededGateway();

    const created = await requestJson<EventTypeReadJson>(address, 'POST', '/v1/event-types', TENANT_A_KEY, {
      eventType: 'user.created',
      description: ' User lifecycle event ',
      schemaExample: { id: 42, email: 'user@example.com' },
    });
    expect(created.status).toBe(201);
    expect(created.body.eventType).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      eventType: 'user.created',
      description: 'User lifecycle event',
      schemaExample: { id: 42, email: 'user@example.com' },
      archivedAt: null,
    });

    const duplicate = await requestJson<ErrorJson>(address, 'POST', '/v1/event-types', TENANT_A_KEY, {
      eventType: 'user.created',
      schemaExample: { id: 43 },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('conflict');

    const listed = await requestJson<EventTypeListJson>(address, 'GET', '/v1/event-types', TENANT_A_KEY);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([created.body.eventType]);

    const updated = await requestJson<EventTypeReadJson>(
      address,
      'PATCH',
      `/v1/event-types/${created.body.eventType.id}`,
      TENANT_A_KEY,
      {
        description: 'Updated event',
        schemaExample: { id: 99 },
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.eventType).toMatchObject({
      id: created.body.eventType.id,
      eventType: 'user.created',
      description: 'Updated event',
      schemaExample: { id: 99 },
    });

    const archived = await requestRaw(address, 'DELETE', `/v1/event-types/${created.body.eventType.id}`, TENANT_A_KEY);
    expect(archived.status).toBe(204);
    expect(await archived.text()).toBe('');

    const readArchived = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/event-types/${created.body.eventType.id}`,
      TENANT_A_KEY,
    );
    expect(readArchived.status).toBe(404);
    const listAfterArchive = await requestJson<EventTypeListJson>(address, 'GET', '/v1/event-types', TENANT_A_KEY);
    expect(listAfterArchive.body.data).toEqual([]);

    const recreated = await requestJson<EventTypeReadJson>(address, 'POST', '/v1/event-types', TENANT_A_KEY, {
      eventType: 'user.created',
    });
    expect(recreated.status).toBe(201);
    expect(recreated.body.eventType.id).not.toBe(created.body.eventType.id);
    expect(recreated.body.eventType.schemaExample).toBeNull();
  });

  it('enforces validation and tenant isolation', async () => {
    const { address } = await startSeededGateway();
    const created = await requestJson<EventTypeReadJson>(address, 'POST', '/v1/event-types', TENANT_A_KEY, {
      eventType: 'invoice.paid',
      schemaExample: { id: 'inv_123' },
    });

    const otherTenantRead = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/event-types/${created.body.eventType.id}`,
      TENANT_B_KEY,
    );
    expect(otherTenantRead.status).toBe(404);

    const otherTenantList = await requestJson<EventTypeListJson>(address, 'GET', '/v1/event-types', TENANT_B_KEY);
    expect(otherTenantList.body.data).toEqual([]);

    await expectEventTypeError(address, { eventType: 'bad type' });
    await expectEventTypeError(address, { eventType: 'valid.name', description: "bad\tvalue" });
    await expectEventTypeError(address, { eventType: 'valid.name', schemaExample: null });
    await expectEventTypeError(address, { eventType: 'valid.name', schemaExample: Number.NaN });

    const emptyPatch = await requestJson<ErrorJson>(
      address,
      'PATCH',
      `/v1/event-types/${created.body.eventType.id}`,
      TENANT_A_KEY,
      {},
    );
    expect(emptyPatch.status).toBe(400);
    expect(emptyPatch.body.error.code).toBe('invalid_request');
  });
});

async function startSeededGateway(): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_a', 'Tenant A', TENANT_A_KEY);
  seedTenant(storage, 'app_b', 'Tenant B', TENANT_B_KEY);
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
      now: () => new Date('2026-06-12T12:00:00.000Z'),
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
    .run(`ak_${appId}`, appId, hashApiKey(apiKey), 'Test key', null, '2026-06-12T00:00:00.000Z');
}

async function expectEventTypeError(address: GatewayAddress, body: Record<string, unknown>): Promise<void> {
  const response = await requestJson<ErrorJson>(address, 'POST', '/v1/event-types', TENANT_A_KEY, body);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('invalid_request');
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: T }> {
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
