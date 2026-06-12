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

const TENANT_KEY = `phk_${Buffer.alloc(32, 81).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 82).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

const activeGateways: Gateway[] = [];

interface EndpointDeliveryHistoryJson {
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

interface EndpointStatsJson {
  readonly stats: {
    readonly endpointId: string;
    readonly windowDays: number;
    readonly since: string;
    readonly until: string;
    readonly total: number;
    readonly byStatus: {
      readonly pending: number;
      readonly delivering: number;
      readonly succeeded: number;
      readonly dead_letter: number;
    };
    readonly successRate: number | null;
    readonly averageDurationMs: number | null;
    readonly daily: ReadonlyArray<{
      readonly date: string;
      readonly total: number;
      readonly succeeded: number;
      readonly failed: number;
      readonly deadLettered: number;
    }>;
    readonly failureReasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
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

describe('endpoint observability HTTP routes', () => {
  it('lists endpoint delivery history with keyset pagination and no payload or secret material', async () => {
    const { address, storage, endpointId, endpointSecret } = await startSeededGateway();
    const first = seedDelivery(storage, 'app_observe', 'user.created', { private: 'payload-secret-1' }, '2026-06-12T10:00:00.000Z');
    const second = seedDelivery(storage, 'app_observe', 'user.created', { private: 'payload-secret-2' }, '2026-06-12T11:00:00.000Z');
    const third = seedDelivery(storage, 'app_observe', 'user.created', { private: 'payload-secret-3' }, '2026-06-12T11:30:00.000Z');
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

    const firstPage = await requestJson<EndpointDeliveryHistoryJson>(
      address,
      'GET',
      `/v1/endpoints/${endpointId}/deliveries?limit=2`,
      TENANT_KEY,
    );

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.map((delivery) => delivery.id)).toEqual([third.deliveryId, second.deliveryId]);
    expect(firstPage.body.data[0]).toMatchObject({
      messageId: third.messageId,
      endpointId,
      eventType: 'user.created',
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: '2026-06-12T11:35:00.000Z',
      lastError: null,
    });
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstPage.body)).not.toContain('payload-secret');
    expect(JSON.stringify(firstPage.body)).not.toContain(endpointSecret);
    expect(JSON.stringify(firstPage.body)).not.toContain('sha256:');
    expect(JSON.stringify(firstPage.body)).not.toContain('https://example.com/hooks/observe');

    const secondPage = await requestJson<EndpointDeliveryHistoryJson>(
      address,
      'GET',
      `/v1/endpoints/${endpointId}/deliveries?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor ?? '')}`,
      TENANT_KEY,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.map((delivery) => delivery.id)).toEqual([first.deliveryId]);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('returns endpoint delivery stats for a trailing window', async () => {
    const { address, storage, endpointId } = await startSeededGateway();
    const success = seedDelivery(storage, 'app_observe', 'user.created', { id: 1 }, '2026-06-12T09:00:00.000Z');
    const dead = seedDelivery(storage, 'app_observe', 'user.created', { id: 2 }, '2026-06-11T09:00:00.000Z');
    const pending = seedDelivery(storage, 'app_observe', 'user.created', { id: 3 }, '2026-06-10T09:00:00.000Z');
    const outsideWindow = seedDelivery(storage, 'app_observe', 'user.created', { id: 4 }, '2026-06-01T09:00:00.000Z');
    markDelivery(storage, success.deliveryId, {
      status: 'succeeded',
      attemptCount: 1,
      updatedAt: '2026-06-12T09:00:01.000Z',
    });
    insertAttempt(storage, success.deliveryId, {
      attemptNumber: 1,
      outcome: 'succeeded',
      responseStatus: 204,
      durationMs: 40,
      attemptedAt: '2026-06-12T09:00:01.000Z',
    });
    markDelivery(storage, dead.deliveryId, {
      status: 'dead_letter',
      attemptCount: 2,
      lastError: 'timeout',
      updatedAt: '2026-06-11T09:00:02.000Z',
    });
    insertAttempt(storage, dead.deliveryId, {
      attemptNumber: 1,
      outcome: 'failed',
      responseStatus: 500,
      durationMs: 20,
      failureReason: 'http_500',
      attemptedAt: '2026-06-11T09:00:01.000Z',
    });
    insertAttempt(storage, dead.deliveryId, {
      attemptNumber: 2,
      outcome: 'dead_letter',
      responseStatus: null,
      durationMs: 30,
      failureReason: 'timeout',
      attemptedAt: '2026-06-11T09:00:02.000Z',
    });
    markDelivery(storage, pending.deliveryId, {
      status: 'pending',
      attemptCount: 0,
      updatedAt: '2026-06-10T09:00:00.000Z',
    });
    markDelivery(storage, outsideWindow.deliveryId, {
      status: 'succeeded',
      attemptCount: 1,
      updatedAt: '2026-06-01T09:00:01.000Z',
    });

    const response = await requestJson<EndpointStatsJson>(
      address,
      'GET',
      `/v1/endpoints/${endpointId}/stats?days=3`,
      TENANT_KEY,
    );

    expect(response.status).toBe(200);
    expect(response.body.stats).toMatchObject({
      endpointId,
      windowDays: 3,
      since: '2026-06-09T12:00:00.000Z',
      until: '2026-06-12T12:00:00.000Z',
      total: 3,
      byStatus: {
        pending: 1,
        delivering: 0,
        succeeded: 1,
        dead_letter: 1,
      },
      successRate: 1 / 3,
      averageDurationMs: 40,
      failureReasons: [
        { reason: 'http_500', count: 1 },
        { reason: 'timeout', count: 1 },
      ],
    });
    expect(response.body.stats.daily).toEqual([
      { date: '2026-06-10', total: 1, succeeded: 0, failed: 0, deadLettered: 0 },
      { date: '2026-06-11', total: 1, succeeded: 0, failed: 1, deadLettered: 1 },
      { date: '2026-06-12', total: 1, succeeded: 1, failed: 0, deadLettered: 0 },
    ]);
  });

  it('returns empty stats for endpoints without deliveries', async () => {
    const { address, endpointId } = await startSeededGateway();

    const response = await requestJson<EndpointStatsJson>(
      address,
      'GET',
      `/v1/endpoints/${endpointId}/stats`,
      TENANT_KEY,
    );

    expect(response.status).toBe(200);
    expect(response.body.stats).toMatchObject({
      total: 0,
      byStatus: {
        pending: 0,
        delivering: 0,
        succeeded: 0,
        dead_letter: 0,
      },
      successRate: null,
      averageDurationMs: null,
      daily: [],
      failureReasons: [],
    });
  });

  it('keeps endpoint observability tenant-scoped and validates query parameters', async () => {
    const { address, endpointId } = await startSeededGateway();

    const missingAuth = await fetch(`${address.url}/v1/endpoints/${endpointId}/deliveries`);
    expect(missingAuth.status).toBe(401);

    const otherTenant = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/endpoints/${endpointId}/deliveries`,
      OTHER_TENANT_KEY,
    );
    expect(otherTenant.status).toBe(404);

    const otherTenantInvalidQuery = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/endpoints/${endpointId}/stats?days=0`,
      OTHER_TENANT_KEY,
    );
    expect(otherTenantInvalidQuery.status).toBe(404);

    const wrongMethod = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${endpointId}/stats`,
      TENANT_KEY,
    );
    expect(wrongMethod.status).toBe(405);

    for (const path of [
      `/v1/endpoints/${endpointId}/deliveries?limit=0`,
      `/v1/endpoints/${endpointId}/deliveries?limit=101`,
      `/v1/endpoints/${endpointId}/deliveries?cursor=not-a-cursor`,
      `/v1/endpoints/${endpointId}/stats?days=0`,
      `/v1/endpoints/${endpointId}/stats?days=91`,
      `/v1/endpoints/${endpointId}/stats?days=seven`,
    ]) {
      const invalid = await requestJson<ErrorJson>(address, 'GET', path, TENANT_KEY);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('invalid_request');
    }
  });
});

async function startSeededGateway(): Promise<{
  readonly address: GatewayAddress;
  readonly storage: PosthornStorage;
  readonly endpointId: string;
  readonly endpointSecret: string;
}> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_observe', 'Observe Tenant', TENANT_KEY);
  seedTenant(storage, 'app_other', 'Other Tenant', OTHER_TENANT_KEY);
  const endpoint = createEndpoint(
    storage,
    'app_observe',
    {
      url: 'https://example.com/hooks/observe',
      eventTypes: ['user.created'],
    },
    NOW,
  );
  createEndpoint(
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
  return { address: await gateway.start(), storage, endpointId: endpoint.endpoint.id, endpointSecret: endpoint.secret };
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
  const result = acceptMessage(storage, appId, eventTypePayload(eventType, payload), new Date(createdAt));
  expect(result.fanout.deliveryIds).toHaveLength(1);
  return {
    messageId: result.message.id,
    deliveryId: result.fanout.deliveryIds[0],
  };
}

function eventTypePayload(eventType: string, payload: Record<string, unknown>): { readonly eventType: string; readonly payload: Record<string, unknown> } {
  return { eventType, payload };
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
      `datt_test_${input.attemptNumber}_${deliveryId}`,
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
