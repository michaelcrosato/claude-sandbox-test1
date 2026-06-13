import { afterEach, describe, expect, it } from 'vitest';

import {
  createGateway,
  hashApiKey,
  IMPLEMENTED_ROUTES,
  POSTHORN_ADMIN_CLIENT_ROUTES,
  openStorage,
  PosthornAdminClient,
  POSTHORN_CLIENT_ROUTES,
  PosthornApiError,
  PosthornClient,
  runDeliveryWorkerTick,
  type DeliveryFetch,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 51).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 52).toString('base64url')}`;
const ADMIN_TOKEN = '0123456789abcdef';
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
      rateLimitPerSecond: 4,
      payloadFormat: 'payload_only',
    });
    expect(created.endpoint.id).toMatch(/^ep_/);
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.endpoint.rateLimitPerSecond).toBe(4);
    expect(created.endpoint.payloadFormat).toBe('payload_only');

    expect((await client.listEndpoints()).data).toEqual([created.endpoint]);
    expect(await client.getEndpoint(created.endpoint.id)).toEqual({ endpoint: created.endpoint });

    const updated = await client.updateEndpoint(created.endpoint.id, {
      headers: { 'X-Trace-Id': 'sdk-updated' },
      eventTypes: null,
      rateLimitPerSecond: null,
      payloadFormat: null,
      enabled: true,
    });
    expect(updated.endpoint).toMatchObject({
      id: created.endpoint.id,
      eventTypes: null,
      headers: { 'X-Trace-Id': 'sdk-updated' },
      rateLimitPerSecond: null,
      payloadFormat: 'envelope',
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

    const deduped = await client.sendMessage({
      eventType: 'sdk.deduped',
      payload: { id: 4 },
      deduplicationKey: 'sdk-deduped-4',
      deduplicationWindowSeconds: 3600,
    });
    const duplicate = await client.sendMessage({
      eventType: 'sdk.deduped',
      payload: { id: 4, noisy: true },
      deduplicationKey: 'sdk-deduped-4',
      deduplicationWindowSeconds: 3600,
    });
    expect(duplicate).toEqual(deduped);

    const usage = await client.getUsage();
    expect(usage.usage).toMatchObject({
      appId: 'app_sdk',
      month: '2026-06',
      messagesAccepted: 3,
      deliveryAttempts: 1,
    });

    await client.deleteEndpoint(created.endpoint.id);
    expect((await client.listEndpoints()).data).toEqual([]);
  });

  it('exercises SDK helpers for implemented tenant routes added after the first client surface', async () => {
    const delivered: DeliveredRequest[] = [];
    const { address, storage } = await startSeededGateway({
      deliveryFetch: async (url, init) => {
        delivered.push({ url, init });
        return { status: 204 };
      },
    });
    const client = new PosthornClient({ baseUrl: address.url, apiKey: TENANT_KEY });

    const eventType = await client.createEventType({
      eventType: 'sdk.catalog',
      description: 'SDK catalog event',
      schemaExample: { id: 123 },
    });
    expect(eventType.eventType).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      eventType: 'sdk.catalog',
      description: 'SDK catalog event',
      schemaExample: { id: 123 },
    });
    await expect(client.createEventType({ name: 'sdk.catalog' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect((await client.listEventTypes()).data.map((item) => item.id)).toEqual([eventType.eventType.id]);
    expect(await client.getEventType(eventType.eventType.id)).toEqual({ eventType: eventType.eventType });
    const updatedEventType = await client.updateEventType(eventType.eventType.id, {
      description: 'Updated SDK catalog event',
      schemaExample: { id: 456 },
    });
    expect(updatedEventType.eventType).toMatchObject({
      description: 'Updated SDK catalog event',
      schemaExample: { id: 456 },
    });

    const endpoint = await client.createEndpoint({
      url: 'https://example.com/hooks/sdk-parity',
      eventTypes: ['sdk.catalog'],
    });
    const rotated = await client.rotateEndpointSecret(endpoint.endpoint.id, { overlapSeconds: 120 });
    expect(rotated).toMatchObject({
      endpoint: { id: endpoint.endpoint.id },
      previousSecretExpiresAt: '2026-06-12T12:02:00.000Z',
    });
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await client.getEndpoint(endpoint.endpoint.id))).not.toContain(rotated.secret);

    const test = await client.testEndpoint(endpoint.endpoint.id, { eventType: 'sdk.catalog' });
    expect(test.test).toMatchObject({
      endpointId: endpoint.endpoint.id,
      eventType: 'sdk.catalog',
      payloadSource: 'schema_example',
      outcome: 'succeeded',
      responseStatus: 204,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].url).toBe('https://example.com/hooks/sdk-parity');

    const first = await client.sendMessage({ eventType: 'sdk.catalog', payload: { id: 1 } });
    const second = await client.sendMessage({ eventType: 'sdk.catalog', payload: { id: 2 } });
    const messagePage = await client.listMessages({ limit: 1 });
    expect(messagePage.data).toHaveLength(1);
    expect(messagePage.nextCursor).toEqual(expect.any(String));
    const nextMessagePage = await client.listMessages({ limit: 1, cursor: messagePage.nextCursor ?? '' });
    expect(new Set([messagePage.data[0]?.id, nextMessagePage.data[0]?.id])).toEqual(
      new Set([first.message.id, second.message.id]),
    );

    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      fetch: async () => ({ status: 503 }),
    });

    const endpointDeliveries = await client.listEndpointDeliveries(endpoint.endpoint.id, { limit: 5 });
    expect(endpointDeliveries.data.map((delivery) => delivery.status)).toEqual(['dead_letter', 'dead_letter']);

    const endpointStats = await client.getEndpointStats(endpoint.endpoint.id, { days: 3 });
    expect(endpointStats.stats).toMatchObject({
      endpointId: endpoint.endpoint.id,
      total: 2,
      byStatus: {
        pending: 0,
        delivering: 0,
        succeeded: 0,
        dead_letter: 2,
      },
      failureReasons: [{ reason: 'http_503', count: 2 }],
    });

    const deliveries = await client.listDeliveries({
      status: 'dead_letter',
      endpointId: endpoint.endpoint.id,
      eventType: 'sdk.catalog',
      failureReason: 'http_503',
      limit: 5,
    });
    expect(deliveries.data).toHaveLength(2);
    expect(new Set(deliveries.data.map((delivery) => delivery.messageId))).toEqual(
      new Set([first.message.id, second.message.id]),
    );

    const portal = await client.createPortalSession({ endpointId: endpoint.endpoint.id, expiresInSeconds: 600 });
    expect(portal.session).toMatchObject({
      id: expect.stringMatching(/^ps_/),
      appId: 'app_sdk',
      endpointId: endpoint.endpoint.id,
      scope: 'endpoint_management',
      expiresAt: '2026-06-12T12:10:00.000Z',
    });
    expect(portal.session.token).toMatch(/^phs_/);

    await client.deleteEventType(eventType.eventType.id);
    expect((await client.listEventTypes()).data).toEqual([]);
  });

  it('serializes only allowlisted query keys for SDK list helpers', async () => {
    assertClientInputTypes();
    const requestedUrls: string[] = [];
    const client = new PosthornClient({
      baseUrl: 'https://posthorn.example',
      apiKey: TENANT_KEY,
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ data: [], nextCursor: null, stats: { total: 0 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const messageInput: Parameters<PosthornClient['listMessages']>[0] & { readonly token: string } = {
      eventType: 'sdk.catalog',
      after: '2026-06-12T00:00:00.000Z',
      before: '2026-06-13T00:00:00.000Z',
      limit: 10,
      cursor: 'msg_cursor',
      token: 'secret-token',
    };
    const attemptsInput: Parameters<PosthornClient['listMessageAttempts']>[1] & { readonly apiKey: string } = {
      limit: 10,
      cursor: 'attempt_cursor',
      apiKey: 'secret-key',
    };
    const endpointDeliveriesInput: Parameters<PosthornClient['listEndpointDeliveries']>[1] & {
      readonly secret: string;
    } = {
      limit: 10,
      cursor: 'delivery_cursor',
      secret: 'whsec_secret',
    };
    const endpointStatsInput: Parameters<PosthornClient['getEndpointStats']>[1] & { readonly token: string } = {
      days: 7,
      token: 'secret-token',
    };
    const deliveriesInput: Parameters<PosthornClient['listDeliveries']>[0] & { readonly apiKey: string } = {
      status: 'dead_letter',
      endpointId: 'ep_123',
      eventType: 'sdk.catalog',
      failureReason: 'http_503',
      limit: 10,
      cursor: 'delivery_cursor',
      apiKey: 'secret-key',
    };

    await client.listMessages(messageInput);
    await client.listMessageAttempts('msg_123', attemptsInput);
    await client.listEndpointDeliveries('ep_123', endpointDeliveriesInput);
    await client.getEndpointStats('ep_123', endpointStatsInput);
    await client.listDeliveries(deliveriesInput);

    expect(requestedUrls).toEqual([
      'https://posthorn.example/v1/messages?eventType=sdk.catalog&after=2026-06-12T00%3A00%3A00.000Z&before=2026-06-13T00%3A00%3A00.000Z&limit=10&cursor=msg_cursor',
      'https://posthorn.example/v1/messages/msg_123/attempts?limit=10&cursor=attempt_cursor',
      'https://posthorn.example/v1/endpoints/ep_123/deliveries?limit=10&cursor=delivery_cursor',
      'https://posthorn.example/v1/endpoints/ep_123/stats?days=7',
      'https://posthorn.example/v1/deliveries?status=dead_letter&endpointId=ep_123&eventType=sdk.catalog&failureReason=http_503&limit=10&cursor=delivery_cursor',
    ]);
    expect(requestedUrls.join('\n')).not.toContain('secret');
    expect(requestedUrls.join('\n')).not.toContain('apiKey');
    expect(requestedUrls.join('\n')).not.toContain('token');
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

  it('exercises the admin client for app, usage, and API key management', async () => {
    const { address } = await startSeededGateway({ adminToken: ADMIN_TOKEN });
    const admin = new PosthornAdminClient({ baseUrl: address.url, adminToken: ADMIN_TOKEN });

    const created = await admin.createApp({ name: 'SDK Admin Tenant', monthlyMessageQuota: 10 });
    expect(created.app).toMatchObject({
      id: expect.stringMatching(/^app_/),
      name: 'SDK Admin Tenant',
      monthlyMessageQuota: 10,
      createdAt: expect.any(String),
    });
    expect((await admin.listApps()).data.map((app) => app.id)).toContain(created.app.id);
    expect(await admin.getApp(created.app.id)).toEqual({ app: created.app });

    const updated = await admin.updateApp(created.app.id, {
      name: 'SDK Admin Tenant Plus',
      monthlyMessageQuota: null,
    });
    expect(updated.app).toEqual({
      ...created.app,
      name: 'SDK Admin Tenant Plus',
      monthlyMessageQuota: null,
    });

    const key = await admin.createApiKey(created.app.id, { name: 'Primary SDK key' });
    expect(key.secret).toMatch(/^phk_/);
    expect(key.apiKey).toMatchObject({
      id: expect.stringMatching(/^ak_/),
      appId: created.app.id,
      name: 'Primary SDK key',
      revokedAt: null,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(key.apiKey)).not.toContain(key.secret);
    expect((await admin.listApiKeys(created.app.id)).data).toEqual([key.apiKey]);

    const tenant = new PosthornClient({ baseUrl: address.url, apiKey: key.secret });
    await tenant.sendMessage({ eventType: 'admin.sdk', payload: { id: 1 } });
    const usage = await admin.getAppUsage(created.app.id);
    expect(usage.usage).toMatchObject({
      appId: created.app.id,
      messagesAccepted: 1,
      deliveryAttempts: 0,
      quota: {
        monthlyMessageQuota: null,
        remaining: null,
      },
    });
    const rotatedSystemSecret = await admin.rotateAppSystemSecret(created.app.id, { overlapSeconds: 120 });
    expect(rotatedSystemSecret).toEqual({
      app: updated.app,
      secret: expect.stringMatching(/^whsec_/),
      previousSecretExpiresAt: null,
    });

    await admin.revokeApiKey(key.apiKey.id);
    expect((await admin.listApiKeys(created.app.id)).data[0]).toMatchObject({
      id: key.apiKey.id,
      revokedAt: expect.any(String),
    });
    await expect(tenant.listEndpoints()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });

    await admin.deleteApp(created.app.id);
    await expect(admin.getApp(created.app.id)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('uses PosthornApiError for admin authentication failures', async () => {
    const { address } = await startSeededGateway({ adminToken: ADMIN_TOKEN });
    const admin = new PosthornAdminClient({ baseUrl: address.url, adminToken: 'wrong-admin-token' });

    await expect(admin.listApps()).rejects.toMatchObject({
      name: 'PosthornApiError',
      status: 401,
      code: 'unauthorized',
      message: 'Invalid bearer token.',
    });
  });

  it('keeps SDK method routes covered by implemented OpenAPI routes', () => {
    const implemented = new Set(IMPLEMENTED_ROUTES.map(routeKey));
    const sdkRoutes = new Set(POSTHORN_CLIENT_ROUTES.map(routeKey));
    const methodNames = new Set(POSTHORN_CLIENT_ROUTES.map((route) => route.methodName));
    const adminSdkRoutes = new Set(POSTHORN_ADMIN_CLIENT_ROUTES.map(routeKey));
    const adminMethodNames = new Set(POSTHORN_ADMIN_CLIENT_ROUTES.map((route) => route.methodName));

    expect(methodNames.size).toBe(POSTHORN_CLIENT_ROUTES.length);
    expect(adminMethodNames.size).toBe(POSTHORN_ADMIN_CLIENT_ROUTES.length);
    expect(sdkRoutes).toEqual(
      new Set([
        'GET /v1/endpoints',
        'POST /v1/endpoints',
        'GET /v1/endpoints/{id}',
        'PATCH /v1/endpoints/{id}',
        'DELETE /v1/endpoints/{id}',
        'POST /v1/endpoints/{id}/rotate-secret',
        'POST /v1/endpoints/{id}/test',
        'GET /v1/endpoints/{id}/deliveries',
        'GET /v1/endpoints/{id}/stats',
        'GET /v1/deliveries',
        'GET /v1/event-types',
        'POST /v1/event-types',
        'GET /v1/event-types/{id}',
        'PATCH /v1/event-types/{id}',
        'DELETE /v1/event-types/{id}',
        'POST /v1/messages',
        'POST /v1/messages/batch',
        'GET /v1/messages',
        'GET /v1/messages/{id}',
        'POST /v1/messages/{id}/retry',
        'GET /v1/messages/{id}/attempts',
        'GET /v1/usage',
        'POST /v1/portal/sessions',
      ]),
    );
    for (const route of sdkRoutes) {
      expect(implemented.has(route), route).toBe(true);
    }
    expect(adminSdkRoutes).toEqual(
      new Set([
        'GET /v1/admin/apps',
        'POST /v1/admin/apps',
        'GET /v1/admin/apps/{id}',
        'PATCH /v1/admin/apps/{id}',
        'DELETE /v1/admin/apps/{id}',
        'GET /v1/admin/apps/{id}/usage',
        'POST /v1/admin/apps/{id}/rotate-system-secret',
        'GET /v1/admin/apps/{id}/keys',
        'POST /v1/admin/apps/{id}/keys',
        'DELETE /v1/admin/keys/{id}',
      ]),
    );
    for (const route of adminSdkRoutes) {
      expect(implemented.has(route), route).toBe(true);
    }
  });
});

interface StartSeededGatewayOptions {
  readonly deliveryFetch?: DeliveryFetch;
  readonly adminToken?: string;
}

async function startSeededGateway(
  options: StartSeededGatewayOptions = {},
): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_sdk', 'SDK Tenant', TENANT_KEY);
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
      ...(options.adminToken === undefined ? {} : { adminToken: options.adminToken }),
    },
    {
      openStorage: () => storage,
      now: () => NOW,
      ...(options.deliveryFetch === undefined ? {} : { deliveryFetch: options.deliveryFetch }),
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start(), storage };
}

interface DeliveredRequest {
  readonly url: string;
  readonly init: Parameters<DeliveryFetch>[1];
}

function assertClientInputTypes(): void {
  const createEndpoint: Parameters<PosthornClient['createEndpoint']>[0] = {
    url: 'https://example.com/hook',
    rateLimitPerSecond: 1,
    payloadFormat: 'payload_only',
  };
  const updateEndpoint: Parameters<PosthornClient['updateEndpoint']>[1] = {
    rateLimitPerSecond: null,
    payloadFormat: null,
  };
  const endpointDeliveries: Parameters<PosthornClient['listEndpointDeliveries']>[1] = { limit: 1, cursor: 'cursor' };
  const endpointStats: Parameters<PosthornClient['getEndpointStats']>[1] = { days: 7 };
  const sendMessage: Parameters<PosthornClient['sendMessage']>[0] = {
    eventType: 'sdk.created',
    payload: { id: 1 },
    deduplicationKey: 'dedupe-key',
    deduplicationWindowSeconds: 60,
  };
  const invalidCreateEndpoint: Parameters<PosthornClient['createEndpoint']>[0] = {
    url: 'https://example.com/hook',
    // @ts-expect-error endpoint rate limits are typed as numbers, not strings.
    rateLimitPerSecond: '1',
  };
  const invalidPayloadFormatEndpoint: Parameters<PosthornClient['createEndpoint']>[0] = {
    url: 'https://example.com/hook',
    // @ts-expect-error endpoint payload format is a closed enum.
    payloadFormat: 'payload',
  };
  const invalidSendMessage: Parameters<PosthornClient['sendMessage']>[0] = {
    eventType: 'sdk.created',
    payload: { id: 1 },
    // @ts-expect-error deduplication windows are typed as numbers, not strings.
    deduplicationWindowSeconds: '60',
  };
  // @ts-expect-error endpoint delivery limits are typed as numbers, not strings.
  const invalidEndpointDeliveries: Parameters<PosthornClient['listEndpointDeliveries']>[1] = { limit: '1' };
  // @ts-expect-error endpoint stats days are typed as numbers, not strings.
  const invalidEndpointStats: Parameters<PosthornClient['getEndpointStats']>[1] = { days: '7' };
  void [
    createEndpoint,
    updateEndpoint,
    endpointDeliveries,
    endpointStats,
    sendMessage,
    invalidCreateEndpoint,
    invalidPayloadFormatEndpoint,
    invalidSendMessage,
    invalidEndpointDeliveries,
    invalidEndpointStats,
  ];
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
