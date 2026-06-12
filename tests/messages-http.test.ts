import { afterEach, describe, expect, it } from 'vitest';

import {
  createEndpoint,
  createGateway,
  getMessage,
  hashApiKey,
  listDeliveriesForMessage,
  loadConfig,
  openStorage,
  updateEndpoint,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_A_KEY = `phk_${Buffer.alloc(32, 11).toString('base64url')}`;
const TENANT_B_KEY = `phk_${Buffer.alloc(32, 12).toString('base64url')}`;
const REVOKED_KEY = `phk_${Buffer.alloc(32, 13).toString('base64url')}`;

const activeGateways: Gateway[] = [];

interface MessageJson {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface FanoutJson {
  readonly matched: number;
  readonly deliveryIds: readonly string[];
  readonly endpointIds: readonly string[];
}

interface AcceptedMessageJson {
  readonly message: MessageJson;
  readonly fanout: FanoutJson;
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

describe('message intake HTTP route', () => {
  it('authenticates producers, accepts a valid message, and persists it for readback', async () => {
    const { address, storage } = await startSeededGateway();

    const response = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 42, email: 'user@example.com' },
    });

    expect(response.status).toBe(202);
    expect(response.body.message).toMatchObject({
      eventType: 'user.created',
      payload: { id: 42, email: 'user@example.com' },
    });
    expect(response.body.message.id).toMatch(/^msg_/);
    expect(response.body.message.createdAt).toEqual(expect.any(String));
    expect(response.body.fanout).toEqual({
      matched: 0,
      deliveryIds: [],
      endpointIds: [],
    });

    expect(getMessage(storage, 'app_a', response.body.message.id)).toEqual(response.body.message);
    expect(getMessage(storage, 'app_b', response.body.message.id)).toBeNull();
  });

  it('rejects missing auth, revoked auth, malformed JSON, and invalid message bodies', async () => {
    const { address } = await startSeededGateway();

    const missingAuth = await fetch(`${address.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ eventType: 'user.created', payload: {} }),
    });
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      error: { code: 'unauthorized', message: 'Invalid bearer token.' },
    });

    const revokedAuth = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', REVOKED_KEY, {
      eventType: 'user.created',
      payload: {},
    });
    expect(revokedAuth.status).toBe(401);

    const malformedJson = await fetch(`${address.url}/v1/messages`, {
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

    await expectMessageError(address, { payload: {} });
    await expectMessageError(address, { eventType: 'bad type', payload: {} });
    await expectMessageError(address, { eventType: 'user.created' });
    await expectMessageError(address, { eventType: 'user.created', payload: null });
  });

  it('accepts a message with no matching endpoints without creating delivery tasks', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/invoices',
      eventTypes: ['invoice.paid'],
    });

    const response = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 1 },
    });

    expect(response.status).toBe(202);
    expect(response.body.fanout).toEqual({
      matched: 0,
      deliveryIds: [],
      endpointIds: [],
    });
    expect(listDeliveriesForMessage(storage, 'app_a', response.body.message.id)).toEqual([]);
  });

  it('fans out to one enabled endpoint whose filter matches the event type', async () => {
    const { address, storage } = await startSeededGateway();
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/users',
      eventTypes: ['user.created'],
    }).endpoint;

    const response = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 2 },
    });

    expect(response.status).toBe(202);
    expect(response.body.fanout.matched).toBe(1);
    expect(response.body.fanout.deliveryIds).toHaveLength(1);
    expect(response.body.fanout.deliveryIds[0]).toMatch(/^del_/);
    expect(response.body.fanout.endpointIds).toEqual([endpoint.id]);
    expect(listDeliveriesForMessage(storage, 'app_a', response.body.message.id)).toEqual([
      expect.objectContaining({
        endpointId: endpoint.id,
        messageId: response.body.message.id,
        status: 'pending',
        attemptCount: 0,
      }),
    ]);
  });

  it('fans out to multiple matching enabled endpoints and skips disabled or other-tenant endpoints', async () => {
    const { address, storage } = await startSeededGateway();
    const matchAll = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/all',
    }).endpoint;
    const matchFiltered = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/payments',
      eventTypes: ['payment.created'],
    }).endpoint;
    const disabled = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/disabled',
      eventTypes: ['payment.created'],
    }).endpoint;
    updateEndpoint(storage, 'app_a', disabled.id, { enabled: false });
    const otherTenant = createEndpoint(storage, 'app_b', {
      url: 'https://example.com/hooks/other',
      eventTypes: ['payment.created'],
    }).endpoint;

    const response = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'payment.created',
      payload: { id: 'pay_123' },
    });

    expect(response.status).toBe(202);
    expect(response.body.fanout.matched).toBe(2);
    expect(response.body.fanout.endpointIds).toEqual([matchAll.id, matchFiltered.id]);
    expect(response.body.fanout.endpointIds).not.toContain(disabled.id);
    expect(response.body.fanout.endpointIds).not.toContain(otherTenant.id);

    const deliveries = listDeliveriesForMessage(storage, 'app_a', response.body.message.id);
    expect(deliveries.map((delivery) => delivery.endpointId)).toEqual([matchAll.id, matchFiltered.id]);
    expect(deliveries.every((delivery) => delivery.status === 'pending' && delivery.attemptCount === 0)).toBe(true);
    expect(listDeliveriesForMessage(storage, 'app_b', response.body.message.id)).toEqual([]);
  });
});

async function startSeededGateway(): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
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
    },
    {
      openStorage: () => storage,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start(), storage };
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

async function expectMessageError(address: GatewayAddress, body: Record<string, unknown>): Promise<void> {
  const response = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('invalid_request');
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
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
    body: (response.status === 204 ? null : await response.json()) as T,
  };
}
