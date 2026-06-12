import { afterEach, describe, expect, it } from 'vitest';

import {
  createEndpoint,
  createGateway,
  hashApiKey,
  loadConfig,
  openStorage,
  runDeliveryWorkerTick,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 31).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 32).toString('base64url')}`;
const ADMIN_TOKEN = '0123456789abcdef';
const DEFAULT_NOW = new Date('2026-06-12T12:00:00.000Z');

const activeGateways: Gateway[] = [];

interface AcceptedMessageJson {
  readonly message: {
    readonly id: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly createdAt: string;
  };
  readonly fanout: {
    readonly matched: number;
    readonly deliveryIds: readonly string[];
    readonly endpointIds: readonly string[];
  };
}

type BatchItemJson =
  | {
      readonly ok: true;
      readonly message: AcceptedMessageJson['message'];
      readonly fanout: AcceptedMessageJson['fanout'];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

interface BatchJson {
  readonly results: readonly BatchItemJson[];
}

interface UsageJson {
  readonly usage: {
    readonly appId: string;
    readonly month: string;
    readonly messagesAccepted: number;
    readonly deliveryAttempts: number;
    readonly quota: {
      readonly monthlyMessageQuota: number | null;
      readonly remaining: number | null;
      readonly exceeded: boolean;
    };
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

describe('usage HTTP routes and quota enforcement', () => {
  it('meters accepted messages, leaves idempotent retries uncounted, and rejects new fanout at quota', async () => {
    const { address, storage } = await startSeededGateway({ monthlyMessageQuota: 1 });
    createEndpoint(storage, 'app_usage', {
      url: 'https://example.com/hooks/usage-quota',
      eventTypes: ['user.created'],
    });

    const before = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);
    expect(before.status).toBe(200);
    expect(before.body.usage).toEqual({
      appId: 'app_usage',
      month: '2026-06',
      messagesAccepted: 0,
      deliveryAttempts: 0,
      quota: {
        monthlyMessageQuota: 1,
        remaining: 1,
        exceeded: false,
      },
    });

    const body = {
      eventType: 'user.created',
      payload: { id: 1 },
      idempotencyKey: 'usage-quota-idempotent',
    };
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, body);
    const retry = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, body);

    expect(accepted.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual(accepted.body);
    expect(accepted.body.fanout.matched).toBe(1);

    const atQuota = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);
    expect(atQuota.body.usage).toEqual({
      appId: 'app_usage',
      month: '2026-06',
      messagesAccepted: 1,
      deliveryAttempts: 0,
      quota: {
        monthlyMessageQuota: 1,
        remaining: 0,
        exceeded: true,
      },
    });

    const rejected = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'user.created',
      payload: { id: 2 },
    });

    expect(rejected.status).toBe(429);
    expect(rejected.body).toEqual({
      error: {
        code: 'quota_exceeded',
        message: 'Monthly message quota exceeded.',
      },
    });
    expect(countMessages(storage, 'app_usage')).toBe(1);
    expect(countDeliveries(storage, 'app_usage')).toBe(1);

    const otherTenantUsage = await requestJson<UsageJson>(address, 'GET', '/v1/usage', OTHER_TENANT_KEY);
    expect(otherTenantUsage.status).toBe(200);
    expect(otherTenantUsage.body.usage).toMatchObject({
      appId: 'app_other',
      messagesAccepted: 0,
      deliveryAttempts: 0,
      quota: {
        monthlyMessageQuota: null,
        remaining: null,
        exceeded: false,
      },
    });
  });

  it('returns per-item quota_exceeded results after earlier batch items consume remaining quota', async () => {
    const { address, storage } = await startSeededGateway({ monthlyMessageQuota: 1 });
    createEndpoint(storage, 'app_usage', {
      url: 'https://example.com/hooks/batch-quota',
      eventTypes: ['user.created'],
    });

    const firstBatch = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_KEY, [
      { eventType: 'user.created', payload: { id: 101 }, idempotencyKey: 'batch-quota-first' },
      { eventType: 'user.created', payload: { id: 102 } },
    ]);
    const usageAfterFirstBatch = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);
    const retryBatch = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_KEY, [
      { eventType: 'user.created', payload: { id: 101 }, idempotencyKey: 'batch-quota-first' },
      { eventType: 'user.created', payload: { id: 103 } },
    ]);

    expect(firstBatch.status).toBe(200);
    const firstAccepted = expectBatchOk(firstBatch.body.results[0]);
    const firstRejected = expectBatchError(firstBatch.body.results[1]);
    expect(firstAccepted.fanout.matched).toBe(1);
    expect(firstRejected.error).toEqual({
      code: 'quota_exceeded',
      message: 'Monthly message quota exceeded.',
    });
    expect(usageAfterFirstBatch.body.usage).toMatchObject({
      messagesAccepted: 1,
      quota: {
        monthlyMessageQuota: 1,
        remaining: 0,
        exceeded: true,
      },
    });

    expect(retryBatch.status).toBe(200);
    expect(expectBatchOk(retryBatch.body.results[0])).toEqual(firstAccepted);
    expect(expectBatchError(retryBatch.body.results[1]).error.code).toBe('quota_exceeded');
    expect(countMessages(storage, 'app_usage')).toBe(1);
    expect(countDeliveries(storage, 'app_usage')).toBe(1);
  });

  it('meters each recorded delivery attempt as a delivery operation', async () => {
    const { address, storage } = await startSeededGateway({ monthlyMessageQuota: 10 });
    createEndpoint(storage, 'app_usage', {
      url: 'https://example.com/hooks/delivery-usage',
      eventTypes: ['invoice.paid'],
    });
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_1' },
    });

    const first = await runDeliveryWorkerTick(storage, {
      now: () => DEFAULT_NOW,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      fetch: async () => ({ status: 503 }),
    });
    const afterFirst = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);

    const second = await runDeliveryWorkerTick(storage, {
      now: () => new Date(DEFAULT_NOW.getTime() + 1),
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      fetch: async () => ({ status: 204 }),
    });
    const afterSecond = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);

    expect(accepted.status).toBe(202);
    expect(first).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 0 });
    expect(afterFirst.body.usage).toMatchObject({
      messagesAccepted: 1,
      deliveryAttempts: 1,
    });
    expect(second).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(afterSecond.body.usage).toMatchObject({
      messagesAccepted: 1,
      deliveryAttempts: 2,
    });
  });

  it('returns admin usage and resets current usage at UTC month boundaries', async () => {
    let now = new Date('2026-05-31T23:59:59.000Z');
    const { address } = await startSeededGateway({
      adminToken: ADMIN_TOKEN,
      monthlyMessageQuota: 1,
      now: () => now,
    });

    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'user.created',
      payload: { id: 10 },
    });
    const tenantMay = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);
    const adminMay = await requestJson<UsageJson>(
      address,
      'GET',
      '/v1/admin/apps/app_usage/usage',
      ADMIN_TOKEN,
    );
    const invalidAdmin = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/admin/apps/app_usage/usage',
      'wrong-admin-token',
    );
    const missingAdmin = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/admin/apps/app_missing/usage',
      ADMIN_TOKEN,
    );
    const blockedMay = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'user.created',
      payload: { id: 11 },
    });

    now = new Date('2026-06-01T00:00:00.000Z');
    const tenantJuneBefore = await requestJson<UsageJson>(address, 'GET', '/v1/usage', TENANT_KEY);
    const acceptedJune = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'user.created',
      payload: { id: 12 },
    });
    const adminJune = await requestJson<UsageJson>(
      address,
      'GET',
      '/v1/admin/apps/app_usage/usage',
      ADMIN_TOKEN,
    );

    expect(accepted.status).toBe(202);
    expect(tenantMay.body).toEqual(adminMay.body);
    expect(tenantMay.body.usage).toMatchObject({
      appId: 'app_usage',
      month: '2026-05',
      messagesAccepted: 1,
      quota: {
        monthlyMessageQuota: 1,
        remaining: 0,
        exceeded: true,
      },
    });
    expect(invalidAdmin.status).toBe(401);
    expect(missingAdmin.status).toBe(404);
    expect(blockedMay.status).toBe(429);
    expect(tenantJuneBefore.body.usage).toMatchObject({
      month: '2026-06',
      messagesAccepted: 0,
      quota: {
        monthlyMessageQuota: 1,
        remaining: 1,
        exceeded: false,
      },
    });
    expect(acceptedJune.status).toBe(202);
    expect(adminJune.body.usage).toMatchObject({
      month: '2026-06',
      messagesAccepted: 1,
      quota: {
        monthlyMessageQuota: 1,
        remaining: 0,
        exceeded: true,
      },
    });
  });

  it('authenticates tenant usage before method dispatch', async () => {
    const { address } = await startSeededGateway();

    const missingAuth = await fetch(`${address.url}/v1/usage`, { method: 'POST' });
    const validWrongMethod = await requestJson<ErrorJson>(address, 'POST', '/v1/usage', TENANT_KEY);

    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      error: { code: 'unauthorized', message: 'Invalid bearer token.' },
    });
    expect(validWrongMethod.status).toBe(405);
    expect(validWrongMethod.body).toEqual({
      error: { code: 'method_not_allowed', message: 'Method not allowed.' },
    });
  });
});

async function startSeededGateway(
  options: {
    readonly adminToken?: string;
    readonly monthlyMessageQuota?: number | null;
    readonly now?: () => Date;
  } = {},
): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_usage', 'Usage Tenant', TENANT_KEY, options.monthlyMessageQuota ?? null);
  seedTenant(storage, 'app_other', 'Other Tenant', OTHER_TENANT_KEY, null);

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
      now: options.now ?? (() => DEFAULT_NOW),
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
  monthlyMessageQuota: number | null,
): void {
  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(appId, name, monthlyMessageQuota, '2026-06-12T00:00:00.000Z');
  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      `ak_${appId}`,
      appId,
      hashApiKey(apiKey),
      'Test key',
      null,
      '2026-06-12T00:00:00.000Z',
    );
}

function countMessages(storage: PosthornStorage, appId: string): number {
  const row = storage.db
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE app_id = ?')
    .get(appId) as unknown as { readonly count: number };
  return Number(row.count);
}

function countDeliveries(storage: PosthornStorage, appId: string): number {
  const row = storage.db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE messages.app_id = ?
      `,
    )
    .get(appId) as unknown as { readonly count: number };
  return Number(row.count);
}

function expectBatchOk(result: BatchItemJson | undefined): Extract<BatchItemJson, { readonly ok: true }> {
  expect(result).toBeDefined();
  expect(result?.ok).toBe(true);
  return result as Extract<BatchItemJson, { readonly ok: true }>;
}

function expectBatchError(result: BatchItemJson | undefined): Extract<BatchItemJson, { readonly ok: false }> {
  expect(result).toBeDefined();
  expect(result?.ok).toBe(false);
  return result as Extract<BatchItemJson, { readonly ok: false }>;
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (response.status === 204 ? null : await response.json()) as T,
  };
}
