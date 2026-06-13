import { afterEach, describe, expect, it } from 'vitest';

import {
  archiveEventType,
  createEndpoint,
  createEventType,
  createGateway,
  hashApiKey,
  loadConfig,
  openStorage,
  rotateEndpointSecret,
  updateEndpoint,
  verifyWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  type DeliveryFetch,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 61).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 62).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

const activeGateways: Gateway[] = [];

interface EndpointTestJson {
  readonly test: {
    readonly id: string;
    readonly endpointId: string;
    readonly eventType: string;
    readonly payloadSource: string;
    readonly outcome: string;
    readonly responseStatus: number | null;
    readonly durationMs: number;
    readonly failureReason: string | null;
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

describe('endpoint test-send HTTP route', () => {
  it('sends a signed test webhook using a schemaExample fallback without durable message mutation', async () => {
    const delivered: DeliveredRequest[] = [];
    const { address, storage, endpointId } = await startSeededGateway(async (url, init) => {
      delivered.push({ url, init });
      return { status: 204 };
    });
    const result = await requestJson<EndpointTestJson>(address, 'POST', `/v1/endpoints/${endpointId}/test`, TENANT_KEY, {
      eventType: 'user.created',
    });

    expect(result.status).toBe(200);
    expect(result.body.test).toMatchObject({
      id: expect.stringMatching(/^test_/),
      endpointId,
      eventType: 'user.created',
      payloadSource: 'schema_example',
      outcome: 'succeeded',
      responseStatus: 204,
      failureReason: null,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].url).toBe('https://example.com/hooks/test');
    expect(delivered[0].init.method).toBe('POST');
    expect(delivered[0].init.redirect).toBe('manual');
    expect(delivered[0].init.headers['X-Customer']).toBe('acme');
    expect(delivered[0].init.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(delivered[0].init.headers['webhook-id']).toBe(result.body.test.id);
    expect(delivered[0].init.headers['webhook-signature']).toMatch(/^v1,/);
    expect(JSON.parse(delivered[0].init.body)).toEqual({
      id: result.body.test.id,
      eventType: 'user.created',
      payload: { id: 1 },
    });
    expect(countRows(storage, 'messages')).toBe(0);
    expect(countRows(storage, 'deliveries')).toBe(0);
    expect(countRows(storage, 'delivery_attempts')).toBe(0);
    expect(countRows(storage, 'usage_months')).toBe(0);
  });

  it('uses explicit payloads, reports HTTP failures, and rejects disabled endpoints before fetch', async () => {
    const delivered: DeliveredRequest[] = [];
    const { address, storage, endpointId } = await startSeededGateway(async (url, init) => {
      delivered.push({ url, init });
      return { status: 503 };
    });

    const explicit = await requestJson<EndpointTestJson>(address, 'POST', `/v1/endpoints/${endpointId}/test`, TENANT_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_123' },
    });
    expect(explicit.status).toBe(200);
    expect(explicit.body.test).toMatchObject({
      payloadSource: 'explicit',
      outcome: 'failed',
      responseStatus: 503,
      failureReason: 'http_503',
    });
    expect(JSON.parse(delivered[0].init.body).payload).toEqual({ id: 'inv_123' });

    updateEndpoint(storage, 'app_test', endpointId, { enabled: false }, NOW);
    const disabled = await requestJson<ErrorJson>(address, 'POST', `/v1/endpoints/${endpointId}/test`, TENANT_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_124' },
    });
    expect(disabled.status).toBe(400);
    expect(disabled.body.error.code).toBe('endpoint_disabled');
    expect(delivered).toHaveLength(1);
  });

  it('uses endpoint payloadFormat for signed test webhook bodies', async () => {
    const delivered: DeliveredRequest[] = [];
    const { address, endpointId, endpointSecret } = await startSeededGateway(
      async (url, init) => {
        delivered.push({ url, init });
        return { status: 204 };
      },
      { payloadFormat: 'payload_only' },
    );

    const result = await requestJson<EndpointTestJson>(address, 'POST', `/v1/endpoints/${endpointId}/test`, TENANT_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_125', total: 1250 },
    });

    expect(result.status).toBe(200);
    expect(result.body.test.payloadSource).toBe('explicit');
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0].init.body)).toEqual({ id: 'inv_125', total: 1250 });
    expect(delivered[0].init.body).not.toContain(result.body.test.id);
    expect(delivered[0].init.body).not.toContain('invoice.paid');
    verifyWebhook(endpointSecret, delivered[0].init.headers, delivered[0].init.body, {
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
  });

  it('uses endpoint deliveryMethod for signed test webhooks without durable mutation', async () => {
    const delivered: DeliveredRequest[] = [];
    const { address, storage, endpointId, endpointSecret } = await startSeededGateway(
      async (url, init) => {
        delivered.push({ url, init });
        return { status: 204 };
      },
      { deliveryMethod: 'PUT', payloadFormat: 'payload_only' },
    );

    const result = await requestJson<EndpointTestJson>(address, 'POST', `/v1/endpoints/${endpointId}/test`, TENANT_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_126', total: 1260 },
    });

    expect(result.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].init.method).toBe('PUT');
    expect(delivered[0].init.redirect).toBe('manual');
    expect(delivered[0].init.body).toBe(JSON.stringify({ id: 'inv_126', total: 1260 }));
    verifyWebhook(endpointSecret, delivered[0].init.headers, delivered[0].init.body, {
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
    expect(() =>
      verifyWebhook(endpointSecret, delivered[0].init.headers, `${delivered[0].init.body}\n`, {
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      }),
    ).toThrow();
    expect(countRows(storage, 'messages')).toBe(0);
    expect(countRows(storage, 'deliveries')).toBe(0);
    expect(countRows(storage, 'delivery_attempts')).toBe(0);
    expect(countRows(storage, 'usage_months')).toBe(0);
  });

  it('signs test webhooks with current and previous endpoint secrets during rotation overlap', async () => {
    const delivered: DeliveredRequest[] = [];
    const { address, storage, endpointId, endpointSecret } = await startSeededGateway(async (url, init) => {
      delivered.push({ url, init });
      return { status: 204 };
    });
    const rotated = rotateEndpointSecret(storage, 'app_test', endpointId, { overlapSeconds: 120 }, NOW);
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error('Expected endpoint rotation.');

    const result = await requestJson<EndpointTestJson>(address, 'POST', `/v1/endpoints/${endpointId}/test`, TENANT_KEY, {
      eventType: 'user.created',
    });

    expect(result.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].init.headers[WEBHOOK_SIGNATURE_HEADER]?.split(' ')).toHaveLength(2);
    verifyWebhook(rotated.secret, delivered[0].init.headers, delivered[0].init.body, {
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
    verifyWebhook(endpointSecret, delivered[0].init.headers, delivered[0].init.body, {
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
  });

  it('requires an active schemaExample when payload is omitted and keeps tenant isolation', async () => {
    const { address, storage, endpointId, eventTypeId } = await startSeededGateway(async () => ({ status: 204 }));

    const missingExample = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${endpointId}/test`,
      TENANT_KEY,
      { eventType: 'missing.example' },
    );
    expect(missingExample.status).toBe(400);
    expect(missingExample.body.error.code).toBe('invalid_request');

    archiveEventType(storage, 'app_test', eventTypeId, NOW);
    const archivedFallback = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${endpointId}/test`,
      TENANT_KEY,
      { eventType: 'user.created' },
    );
    expect(archivedFallback.status).toBe(400);
    expect(archivedFallback.body.error.code).toBe('invalid_request');

    const otherTenant = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/endpoints/${endpointId}/test`,
      OTHER_TENANT_KEY,
      { eventType: 'user.created', payload: { id: 1 } },
    );
    expect(otherTenant.status).toBe(404);
  });
});

interface DeliveredRequest {
  readonly url: string;
  readonly init: Parameters<DeliveryFetch>[1];
}

async function startSeededGateway(
  deliveryFetch: DeliveryFetch,
  endpointInput: { readonly deliveryMethod?: 'POST' | 'PUT'; readonly payloadFormat?: 'envelope' | 'payload_only' } = {},
): Promise<{
  address: GatewayAddress;
  storage: PosthornStorage;
  endpointId: string;
  endpointSecret: string;
  eventTypeId: string;
}> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_test', 'Test Tenant', TENANT_KEY);
  seedTenant(storage, 'app_other', 'Other Tenant', OTHER_TENANT_KEY);
  const createdEndpoint = createEndpoint(storage, 'app_test', {
    url: 'https://example.com/hooks/test',
    headers: { 'X-Customer': 'acme' },
    ...endpointInput,
  }, NOW);
  const endpoint = createdEndpoint.endpoint;
  const eventType = createEventType(storage, 'app_test', {
    eventType: 'user.created',
    schemaExample: { id: 1 },
  }, NOW).eventType;
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
      deliveryFetch,
      now: () => NOW,
    },
  );
  activeGateways.push(gateway);
  return {
    address: await gateway.start(),
    storage,
    endpointId: endpoint.id,
    endpointSecret: createdEndpoint.secret,
    eventTypeId: eventType.id,
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

function countRows(storage: PosthornStorage, table: string): number {
  const row = storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: unknown };
  return Number(row.count);
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
