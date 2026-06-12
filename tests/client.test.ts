import { afterEach, describe, expect, it } from 'vitest';

import {
  createGateway,
  hashApiKey,
  IMPLEMENTED_ROUTES,
  openStorage,
  POSTHORN_CLIENT_ROUTES,
  PosthornApiError,
  PosthornClient,
  runDeliveryWorkerTick,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 51).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 52).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

const activeGateways: Gateway[] = [];

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (gateway !== undefined) {
      await gateway.stop();
    }
  }
});

describe('PosthornClient', () => {
  it('exercises tenant HTTP routes for endpoints, messages, attempts, retry, and usage', async () => {
    const { address, storage } = await startSeededGateway();
    const client = new PosthornClient({ baseUrl: address.url, apiKey: TENANT_KEY });

    const created = await client.createEndpoint({
      url: 'https://example.com/hooks/sdk',
      eventTypes: ['sdk.created'],
      headers: { 'X-Trace-Id': 'sdk-test' },
    });
    expect(created.endpoint.id).toMatch(/^ep_/);
    expect(created.secret).toMatch(/^whsec_/);

    expect((await client.listEndpoints()).data).toEqual([created.endpoint]);
    expect(await client.getEndpoint(created.endpoint.id)).toEqual({ endpoint: created.endpoint });

    const updated = await client.updateEndpoint(created.endpoint.id, {
      headers: { 'X-Trace-Id': 'sdk-updated' },
      eventTypes: null,
      enabled: true,
    });
    expect(updated.endpoint).toMatchObject({
      id: created.endpoint.id,
      eventTypes: null,
      headers: { 'X-Trace-Id': 'sdk-updated' },
      enabled: true,
    });

    const accepted = await client.sendMessage({
      eventType: 'sdk.created',
      payload: { id: 1 },
      idempotencyKey: 'sdk-message-1',
    });
    const retryAccepted = await client.sendMessage({
      eventType: 'sdk.created',
      payload: { id: 1 },
      idempotencyKey: 'sdk-message-1',
    });
    expect(retryAccepted).toEqual(accepted);
    expect(accepted.fanout.matched).toBe(1);

    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      fetch: async () => ({ status: 503 }),
    });
    expect((await client.getMessage(accepted.message.id)).deliveries[0]).toMatchObject({
      status: 'dead_letter',
      attemptCount: 1,
    });
    expect(await client.retryMessage(accepted.message.id)).toEqual({ retried: 1 });
    expect((await client.getMessage(accepted.message.id)).deliveries[0]).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    });

    const attempts = await client.listMessageAttempts(accepted.message.id, { limit: 10 });
    expect(attempts.data).toHaveLength(1);
    expect(attempts.data[0]).toMatchObject({
      messageId: accepted.message.id,
      outcome: 'dead_letter',
      responseStatus: 503,
    });

    const batch = await client.sendMessageBatch([
      { eventType: 'sdk.batch', payload: { id: 2 } },
      { eventType: 'bad type', payload: { id: 3 } },
    ]);
    expect(batch.results[0]?.ok).toBe(true);
    expect(batch.results[1]).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

    const usage = await client.getUsage();
    expect(usage.usage).toMatchObject({
      appId: 'app_sdk',
      month: '2026-06',
      messagesAccepted: 2,
      deliveryAttempts: 1,
    });

    await client.deleteEndpoint(created.endpoint.id);
    expect((await client.listEndpoints()).data).toEqual([]);
  });

  it('throws PosthornApiError with status, stable code, and parsed response body', async () => {
    const { address } = await startSeededGateway();
    const invalidClient = new PosthornClient({ baseUrl: address.url, apiKey: OTHER_TENANT_KEY });
    const client = new PosthornClient({ baseUrl: address.url, apiKey: TENANT_KEY });

    await expect(invalidClient.listEndpoints()).rejects.toMatchObject({
      name: 'PosthornApiError',
      status: 401,
      code: 'unauthorized',
      message: 'Invalid bearer token.',
    });

    try {
      await client.createEndpoint({ url: 'http://127.0.0.1/webhook' });
      throw new Error('Expected createEndpoint to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(PosthornApiError);
      const apiError = error as PosthornApiError;
      expect(apiError.status).toBe(400);
      expect(apiError.code).toBe('url_not_allowed');
      expect(apiError.responseBody).toEqual({
        error: {
          code: 'url_not_allowed',
          message: 'url must not target localhost or private networks.',
        },
      });
    }
  });

  it('keeps SDK method routes covered by implemented OpenAPI routes', () => {
    const implemented = new Set(IMPLEMENTED_ROUTES.map(routeKey));
    const sdkRoutes = new Set(POSTHORN_CLIENT_ROUTES.map(routeKey));
    const methodNames = new Set(POSTHORN_CLIENT_ROUTES.map((route) => route.methodName));

    expect(methodNames.size).toBe(POSTHORN_CLIENT_ROUTES.length);
    expect(sdkRoutes).toEqual(
      new Set([
        'GET /v1/endpoints',
        'POST /v1/endpoints',
        'GET /v1/endpoints/{id}',
        'PATCH /v1/endpoints/{id}',
        'DELETE /v1/endpoints/{id}',
        'POST /v1/messages',
        'POST /v1/messages/batch',
        'GET /v1/messages/{id}',
        'POST /v1/messages/{id}/retry',
        'GET /v1/messages/{id}/attempts',
        'GET /v1/usage',
      ]),
    );
    for (const route of sdkRoutes) {
      expect(implemented.has(route), route).toBe(true);
    }
  });
});

async function startSeededGateway(): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_sdk', 'SDK Tenant', TENANT_KEY);
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
    },
    {
      openStorage: () => storage,
      now: () => NOW,
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
    .run(
      `ak_${appId}`,
      appId,
      hashApiKey(apiKey),
      'SDK key',
      null,
      '2026-06-12T00:00:00.000Z',
    );
}

function routeKey(route: { readonly method: string; readonly path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
