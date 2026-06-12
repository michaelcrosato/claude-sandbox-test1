import { afterEach, describe, expect, it } from 'vitest';

import {
  acceptMessage,
  createEndpoint,
  createGateway,
  hashApiKey,
  loadConfig,
  openStorage,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 91).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 92).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

const activeGateways: Gateway[] = [];

interface DeliveryListJson {
  readonly data: ReadonlyArray<{
    readonly id: string;
    readonly messageId: string;
    readonly endpointId: string;
    readonly eventType: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly nextAttemptAt: string | null;
    readonly lastError: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  readonly nextCursor: string | null;
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

describe('app-wide delivery listing HTTP route', () => {
  it('lists tenant deliveries across endpoints with keyset pagination and no payload or secret material', async () => {
    const { address, storage, userEndpointId, invoiceEndpointId, userEndpointSecret } = await startSeededGateway();
    const first = seedDelivery(storage, 'app_deliveries', 'user.created', { private: 'payload-secret-1' }, '2026-06-12T10:00:00.000Z');
    const second = seedDelivery(storage, 'app_deliveries', 'invoice.paid', { private: 'payload-secret-2' }, '2026-06-12T11:00:00.000Z');
    const third = seedDelivery(storage, 'app_deliveries', 'user.created', { private: 'payload-secret-3' }, '2026-06-12T11:30:00.000Z');
    seedDelivery(storage, 'app_other', 'user.created', { private: 'other-tenant-payload' }, '2026-06-12T11:45:00.000Z');
    markDelivery(storage, first.deliveryId, {
      status: 'succeeded',
      attemptCount: 1,
      updatedAt: '2026-06-12T10:00:01.000Z',
    });
    markDelivery(storage, second.deliveryId, {
      status: 'dead_letter',
      attemptCount: 2,
      lastError: 'http_500',
      updatedAt: '2026-06-12T11:00:02.000Z',
    });
    markDelivery(storage, third.deliveryId, {
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: '2026-06-12T11:35:00.000Z',
      updatedAt: '2026-06-12T11:30:00.000Z',
    });

    const firstPage = await requestJson<DeliveryListJson>(address, 'GET', '/v1/deliveries?limit=2', TENANT_KEY);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.map((delivery) => delivery.id)).toEqual([third.deliveryId, second.deliveryId]);
    expect(firstPage.body.data[0]).toMatchObject({
      messageId: third.messageId,
      endpointId: userEndpointId,
      eventType: 'user.created',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: '2026-06-12T11:35:00.000Z',
      lastError: null,
    });
    expect(firstPage.body.data[1]?.endpointId).toBe(invoiceEndpointId);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstPage.body)).not.toContain('payload-secret');
    expect(JSON.stringify(firstPage.body)).not.toContain('other-tenant-payload');
    expect(JSON.stringify(firstPage.body)).not.toContain(userEndpointSecret);
    expect(JSON.stringify(firstPage.body)).not.toContain('sha256:');
    expect(JSON.stringify(firstPage.body)).not.toContain('https://example.com/hooks');

    const secondPage = await requestJson<DeliveryListJson>(
      address,
      'GET',
      `/v1/deliveries?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor ?? '')}`,
      TENANT_KEY,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.map((delivery) => delivery.id)).toEqual([first.deliveryId]);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('filters deliveries by status, endpointId, eventType, failureReason, and combinations', async () => {
    const { address, storage, userEndpointId, invoiceEndpointId, otherTenantEndpointId } = await startSeededGateway();
    const success = seedDelivery(storage, 'app_deliveries', 'user.created', { id: 1 }, '2026-06-12T09:00:00.000Z');
    const timeout = seedDelivery(storage, 'app_deliveries', 'user.created', { id: 2 }, '2026-06-12T10:00:00.000Z');
    const failed = seedDelivery(storage, 'app_deliveries', 'invoice.paid', { id: 3 }, '2026-06-12T11:00:00.000Z');
    markDelivery(storage, success.deliveryId, {
      status: 'succeeded',
      attemptCount: 1,
      updatedAt: '2026-06-12T09:00:01.000Z',
    });
    markDelivery(storage, timeout.deliveryId, {
      status: 'dead_letter',
      attemptCount: 2,
      lastError: 'timeout',
      updatedAt: '2026-06-12T10:00:02.000Z',
    });
    insertAttempt(storage, timeout.deliveryId, {
      attemptNumber: 1,
      outcome: 'failed',
      responseStatus: null,
      durationMs: 30,
      failureReason: 'network_error',
      attemptedAt: '2026-06-12T10:00:01.000Z',
    });
    markDelivery(storage, failed.deliveryId, {
      status: 'dead_letter',
      attemptCount: 1,
      lastError: 'http_500',
      updatedAt: '2026-06-12T11:00:01.000Z',
    });

    await expectDeliveryIds(address, `/v1/deliveries?status=dead_letter`, [failed.deliveryId, timeout.deliveryId]);
    await expectDeliveryIds(address, `/v1/deliveries?endpointId=${encodeURIComponent(userEndpointId)}`, [
      timeout.deliveryId,
      success.deliveryId,
    ]);
    await expectDeliveryIds(address, '/v1/deliveries?eventType=invoice.paid', [failed.deliveryId]);
    await expectDeliveryIds(address, '/v1/deliveries?failureReason=network_error', [timeout.deliveryId]);
    await expectDeliveryIds(address, '/v1/deliveries?failureReason=http_500', [failed.deliveryId]);
    await expectDeliveryIds(
      address,
      `/v1/deliveries?status=dead_letter&endpointId=${encodeURIComponent(invoiceEndpointId)}`,
      [failed.deliveryId],
    );
    await expectDeliveryIds(address, `/v1/deliveries?endpointId=${encodeURIComponent(otherTenantEndpointId)}`, []);
  });

  it('rejects missing auth, unsupported methods, and invalid query parameters', async () => {
    const { address } = await startSeededGateway();

    const missingAuth = await fetch(`${address.url}/v1/deliveries`);
    expect(missingAuth.status).toBe(401);

    const wrongMethod = await requestJson<ErrorJson>(address, 'POST', '/v1/deliveries', TENANT_KEY);
    expect(wrongMethod.status).toBe(405);

    for (const path of [
      '/v1/deliveries?limit=0',
      '/v1/deliveries?limit=101',
      '/v1/deliveries?cursor=not-a-cursor',
      '/v1/deliveries?status=failed',
      '/v1/deliveries?endpointId=',
      '/v1/deliveries?eventType=bad type',
      `/v1/deliveries?failureReason=${'x'.repeat(101)}`,
    ]) {
      const invalid = await requestJson<ErrorJson>(address, 'GET', path, TENANT_KEY);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('invalid_request');
    }

    const otherTenantList = await requestJson<DeliveryListJson>(address, 'GET', '/v1/deliveries', OTHER_TENANT_KEY);
    expect(otherTenantList.status).toBe(200);
    expect(otherTenantList.body.data).toEqual([]);
  });
});

async function expectDeliveryIds(address: GatewayAddress, path: string, expectedIds: readonly string[]): Promise<void> {
  const response = await requestJson<DeliveryListJson>(address, 'GET', path, TENANT_KEY);
  expect(response.status).toBe(200);
  expect(response.body.data.map((delivery) => delivery.id)).toEqual(expectedIds);
}

async function startSeededGateway(): Promise<{
  readonly address: GatewayAddress;
  readonly storage: PosthornStorage;
  readonly userEndpointId: string;
  readonly invoiceEndpointId: string;
  readonly otherTenantEndpointId: string;
  readonly userEndpointSecret: string;
}> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_deliveries', 'Deliveries Tenant', TENANT_KEY);
  seedTenant(storage, 'app_other', 'Other Tenant', OTHER_TENANT_KEY);
  const userEndpoint = createEndpoint(
    storage,
    'app_deliveries',
    {
      url: 'https://example.com/hooks/users',
      eventTypes: ['user.created'],
    },
    NOW,
  );
  const invoiceEndpoint = createEndpoint(
    storage,
    'app_deliveries',
    {
      url: 'https://example.com/hooks/invoices',
      eventTypes: ['invoice.paid'],
    },
    NOW,
  );
  const otherEndpoint = createEndpoint(
    storage,
    'app_other',
    {
      url: 'https://example.com/hooks/other',
      eventTypes: ['user.created'],
    },
    NOW,
  );
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
  return {
    address: await gateway.start(),
    storage,
    userEndpointId: userEndpoint.endpoint.id,
    invoiceEndpointId: invoiceEndpoint.endpoint.id,
    otherTenantEndpointId: otherEndpoint.endpoint.id,
    userEndpointSecret: userEndpoint.secret,
  };
}

function seedTenant(storage: PosthornStorage, appId: string, name: string, apiKey: string): void {
  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(appId, name, null, '2026-06-12T00:00:00.000Z');
  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`ak_${appId}`, appId, hashApiKey(apiKey), 'Test key', null, '2026-06-12T00:00:00.000Z');
}

function seedDelivery(
  storage: PosthornStorage,
  appId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: string,
): { readonly messageId: string; readonly deliveryId: string } {
  const result = acceptMessage(storage, appId, { eventType, payload }, new Date(createdAt));
  expect(result.fanout.deliveryIds).toHaveLength(1);
  return {
    messageId: result.message.id,
    deliveryId: result.fanout.deliveryIds[0],
  };
}

function markDelivery(
  storage: PosthornStorage,
  deliveryId: string,
  input: {
    readonly status: 'pending' | 'delivering' | 'succeeded' | 'dead_letter';
    readonly attemptCount: number;
    readonly nextAttemptAt?: string | null;
    readonly lastError?: string | null;
    readonly updatedAt: string;
  },
): void {
  storage.db
    .prepare(
      `
        UPDATE deliveries
        SET status = ?,
            attempt_count = ?,
            next_attempt_at = ?,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `,
    )
    .run(
      input.status,
      input.attemptCount,
      input.nextAttemptAt ?? null,
      input.lastError ?? null,
      input.updatedAt,
      deliveryId,
    );
}

function insertAttempt(
  storage: PosthornStorage,
  deliveryId: string,
  input: {
    readonly attemptNumber: number;
    readonly outcome: 'succeeded' | 'failed' | 'dead_letter';
    readonly responseStatus?: number | null;
    readonly durationMs: number;
    readonly failureReason?: string | null;
    readonly attemptedAt: string;
  },
): void {
  storage.db
    .prepare(
      `
        INSERT INTO delivery_attempts (
          id,
          delivery_id,
          attempt_number,
          outcome,
          response_status,
          duration_ms,
          failure_reason,
          attempted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `datt_list_${input.attemptNumber}_${deliveryId}`,
      deliveryId,
      input.attemptNumber,
      input.outcome,
      input.responseStatus ?? null,
      input.durationMs,
      input.failureReason ?? null,
      input.attemptedAt,
    );
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}
