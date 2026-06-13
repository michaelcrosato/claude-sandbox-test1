import { afterEach, describe, expect, it } from 'vitest';

import {
  createEndpoint,
  createGateway,
  getMessage,
  hashApiKey,
  listDeliveriesForMessage,
  loadConfig,
  openStorage,
  runDeliveryWorkerTick,
  updateEndpoint,
  type DeliveryFetch,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_A_KEY = `phk_${Buffer.alloc(32, 11).toString('base64url')}`;
const TENANT_B_KEY = `phk_${Buffer.alloc(32, 12).toString('base64url')}`;
const REVOKED_KEY = `phk_${Buffer.alloc(32, 13).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

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

interface AttemptJson {
  readonly id: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly endpointId: string;
  readonly attemptNumber: number;
  readonly outcome: string;
  readonly attemptedAt: string;
  readonly durationMs: number | null;
  readonly responseStatus: number | null;
  readonly failureReason: string | null;
}

interface AttemptsPageJson {
  readonly data: readonly AttemptJson[];
  readonly nextCursor: string | null;
}

interface MessageListJson {
  readonly data: readonly MessageJson[];
  readonly nextCursor: string | null;
}

interface DeliveryJson {
  readonly id: string;
  readonly messageId: string;
  readonly endpointId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MessageStatusJson {
  readonly message: MessageJson;
  readonly deliveries: readonly DeliveryJson[];
}

interface RetryJson {
  readonly retried: number;
}

type BatchItemJson =
  | {
      readonly ok: true;
      readonly message: MessageJson;
      readonly fanout: FanoutJson;
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
    await expectMessageError(address, { eventType: 'user.created', payload: {}, idempotencyKey: 'key\t' });
    await expectMessageError(address, { eventType: 'user.created', payload: deeplyNestedPayload() });
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
    }, new Date('2026-06-12T00:00:00.001Z')).endpoint;
    const matchFiltered = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/payments',
      eventTypes: ['payment.created'],
    }, new Date('2026-06-12T00:00:00.002Z')).endpoint;
    const disabled = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/disabled',
      eventTypes: ['payment.created'],
    }, new Date('2026-06-12T00:00:00.003Z')).endpoint;
    updateEndpoint(storage, 'app_a', disabled.id, { enabled: false });
    const otherTenant = createEndpoint(storage, 'app_b', {
      url: 'https://example.com/hooks/other',
      eventTypes: ['payment.created'],
    }, new Date('2026-06-12T00:00:00.004Z')).endpoint;

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

  it('stores an idempotency fingerprint and returns the original result for a same-body retry', async () => {
    const { address, storage } = await startSeededGateway();
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/idempotent',
      eventTypes: ['user.created'],
    }).endpoint;
    const body = {
      eventType: 'user.created',
      payload: { id: 7, nested: { b: 2, a: 1 } },
      idempotencyKey: 'retry-user-7',
    };

    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);
    const second = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { nested: { a: 1, b: 2 }, id: 7 },
      idempotencyKey: 'retry-user-7',
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(first.body.fanout).toMatchObject({
      matched: 1,
      endpointIds: [endpoint.id],
    });
    expect(listDeliveriesForMessage(storage, 'app_a', first.body.message.id)).toHaveLength(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);

    const persisted = storage.db
      .prepare('SELECT idempotency_key, payload_hash FROM messages WHERE id = ?')
      .get(first.body.message.id) as unknown as { readonly idempotency_key: string; readonly payload_hash: string };
    expect(persisted.idempotency_key).toBe('retry-user-7');
    expect(persisted.payload_hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns idempotency_conflict when a key is reused with a different request', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/conflict',
      eventTypes: ['user.created'],
    });

    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 8 },
      idempotencyKey: 'conflicting-key',
    });
    const conflict = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 9 },
      idempotencyKey: 'conflicting-key',
    });

    expect(first.status).toBe(202);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: {
        code: 'idempotency_conflict',
        message: 'idempotencyKey was reused with a different request body.',
      },
    });
    expect(countMessages(storage, 'app_a')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
  });

  it('scopes idempotency keys to the authenticated tenant', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/tenant-a',
      eventTypes: ['user.created'],
    });
    createEndpoint(storage, 'app_b', {
      url: 'https://example.com/hooks/tenant-b',
      eventTypes: ['user.created'],
    });
    const body = {
      eventType: 'user.created',
      payload: { id: 10 },
      idempotencyKey: 'tenant-scoped-key',
    };

    const tenantA = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);
    const tenantB = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_B_KEY, body);
    const tenantARetry = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);

    expect(tenantA.status).toBe(202);
    expect(tenantB.status).toBe(202);
    expect(tenantARetry.body).toEqual(tenantA.body);
    expect(tenantB.body.message.id).not.toBe(tenantA.body.message.id);
    expect(countMessages(storage, 'app_a')).toBe(1);
    expect(countMessages(storage, 'app_b')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
    expect(countDeliveries(storage, 'app_b')).toBe(1);
  });

  it('keeps original fanout stable when a matching endpoint is added after an idempotent send', async () => {
    const { address, storage } = await startSeededGateway();
    const originalEndpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/original',
      eventTypes: ['payment.created'],
    }).endpoint;
    const body = {
      eventType: 'payment.created',
      payload: { id: 'pay_456' },
      idempotencyKey: 'stable-fanout',
    };

    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);
    const laterEndpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/later',
      eventTypes: ['payment.created'],
    }).endpoint;
    const retry = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual(first.body);
    expect(retry.body.fanout.endpointIds).toEqual([originalEndpoint.id]);
    expect(retry.body.fanout.endpointIds).not.toContain(laterEndpoint.id);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
  });

  it('deduplicates active producer keys without new fanout, usage, or response metadata leaks', async () => {
    const { address, storage } = await startSeededGateway({ now: () => NOW });
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/deduped',
      eventTypes: ['user.created'],
    }).endpoint;

    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 15 },
      deduplicationKey: 'dedupe-user-15',
      deduplicationWindowSeconds: 3600,
    });
    const duplicate = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 15, noisy: true },
      deduplicationKey: 'dedupe-user-15',
      deduplicationWindowSeconds: 3600,
    });

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toEqual(first.body);
    expect(first.body.fanout.endpointIds).toEqual([endpoint.id]);
    expect(countMessages(storage, 'app_a')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
    expect(countAcceptedMessages(storage, 'app_a')).toBe(1);

    const persisted = storage.db
      .prepare('SELECT deduplication_key, deduplication_expires_at FROM messages WHERE id = ?')
      .get(first.body.message.id) as { readonly deduplication_key: string; readonly deduplication_expires_at: string };
    expect(persisted.deduplication_key).toBe('dedupe-user-15');
    expect(persisted.deduplication_expires_at).toBe('2026-06-12T13:00:00.000Z');

    const message = await requestJson<MessageStatusJson>(
      address,
      'GET',
      `/v1/messages/${first.body.message.id}`,
      TENANT_A_KEY,
    );
    const list = await requestJson<MessageListJson>(address, 'GET', '/v1/messages', TENANT_A_KEY);
    expect(JSON.stringify(message.body)).not.toContain('dedupe-user-15');
    expect(JSON.stringify(message.body)).not.toContain('deduplication');
    expect(JSON.stringify(list.body)).not.toContain('dedupe-user-15');
    expect(JSON.stringify(list.body)).not.toContain('deduplication');
  });

  it('scopes deduplication by tenant and event type and lets expired windows accept new messages', async () => {
    let nowMs = NOW.getTime();
    const { address, storage } = await startSeededGateway({ now: () => new Date(nowMs) });
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/dedupe-user',
      eventTypes: ['user.created'],
    });
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/dedupe-invoice',
      eventTypes: ['invoice.paid'],
    });
    createEndpoint(storage, 'app_b', {
      url: 'https://example.com/hooks/dedupe-other-tenant',
      eventTypes: ['user.created'],
    });

    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 16 },
      deduplicationKey: 'shared-key',
      deduplicationWindowSeconds: 60,
    });
    const differentEvent = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_16' },
      deduplicationKey: 'shared-key',
      deduplicationWindowSeconds: 60,
    });
    const differentTenant = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_B_KEY, {
      eventType: 'user.created',
      payload: { id: 16 },
      deduplicationKey: 'shared-key',
      deduplicationWindowSeconds: 60,
    });
    nowMs += 60_000;
    const expired = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 16, afterWindow: true },
      deduplicationKey: 'shared-key',
      deduplicationWindowSeconds: 60,
    });

    expect(first.status).toBe(202);
    expect(differentEvent.status).toBe(202);
    expect(differentTenant.status).toBe(202);
    expect(expired.status).toBe(202);
    expect(new Set([first.body.message.id, differentEvent.body.message.id, expired.body.message.id]).size).toBe(3);
    expect(differentTenant.body.message.id).not.toBe(first.body.message.id);
    expect(countMessages(storage, 'app_a')).toBe(3);
    expect(countMessages(storage, 'app_b')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(3);
    expect(countDeliveries(storage, 'app_b')).toBe(1);
  });

  it('validates deduplication inputs', async () => {
    const { address } = await startSeededGateway();

    for (const deduplicationKey of [1, false, '', '   ', `${'a'.repeat(201)}`, 'bad\tkey']) {
      await expectMessageError(address, {
        eventType: 'user.created',
        payload: {},
        deduplicationKey,
      });
    }
    for (const deduplicationWindowSeconds of [0, -1, 1.5, 2_592_001, '60', false]) {
      await expectMessageError(address, {
        eventType: 'user.created',
        payload: {},
        deduplicationKey: 'bad-window',
        deduplicationWindowSeconds,
      });
    }
    await expectMessageError(address, {
      eventType: 'user.created',
      payload: {},
      deduplicationWindowSeconds: 60,
    });
  });

  it('keeps idempotency conflicts ahead of deduplication suppression', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/dedupe-idempotency',
      eventTypes: ['user.created'],
    });
    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 17 },
      idempotencyKey: 'dedupe-idempotency',
      deduplicationKey: 'dedupe-idempotency-key',
      deduplicationWindowSeconds: 3600,
    });
    const replayWithMalformedDedupe = await requestJson<AcceptedMessageJson>(
      address,
      'POST',
      '/v1/messages',
      TENANT_A_KEY,
      {
        eventType: 'user.created',
        payload: { id: 17 },
        idempotencyKey: 'dedupe-idempotency',
        deduplicationWindowSeconds: 0,
      },
    );
    const conflict = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 18 },
      idempotencyKey: 'dedupe-idempotency',
      deduplicationKey: 'dedupe-idempotency-key',
      deduplicationWindowSeconds: 0,
    });

    expect(first.status).toBe(202);
    expect(replayWithMalformedDedupe.status).toBe(202);
    expect(replayWithMalformedDedupe.body).toEqual(first.body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
    expect(countMessages(storage, 'app_a')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
  });

  it('rejects malformed batch envelopes and oversized batches', async () => {
    const { address } = await startSeededGateway();

    const nonArray = await requestJson<ErrorJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: {},
    });
    const empty = await requestJson<ErrorJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, []);
    const oversized = await requestJson<ErrorJson>(
      address,
      'POST',
      '/v1/messages/batch',
      TENANT_A_KEY,
      Array.from({ length: 101 }, (_, index) => ({
        eventType: 'user.created',
        payload: { index },
      })),
    );

    expect(nonArray.status).toBe(400);
    expect(nonArray.body.error.code).toBe('invalid_request');
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('invalid_request');
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.code).toBe('invalid_request');
  });

  it('accepts a full 100 item batch', async () => {
    const { address, storage } = await startSeededGateway();

    const batch = await requestJson<BatchJson>(
      address,
      'POST',
      '/v1/messages/batch',
      TENANT_A_KEY,
      Array.from({ length: 100 }, (_, index) => ({
        eventType: 'batch.created',
        payload: { index },
      })),
    );

    expect(batch.status).toBe(200);
    expect(batch.body.results).toHaveLength(100);
    expect(batch.body.results.every((result) => result.ok)).toBe(true);
    expect(countMessages(storage, 'app_a')).toBe(100);
  });

  it('returns per-item results for mixed success and validation failures', async () => {
    const { address, storage } = await startSeededGateway();
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/batch-mixed',
      eventTypes: ['user.created'],
    }).endpoint;

    const batch = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, [
      { eventType: 'user.created', payload: { id: 20 } },
      { payload: { id: 21 } },
      { eventType: 'invoice.paid', payload: { id: 'inv_20' } },
    ]);

    expect(batch.status).toBe(200);
    const first = expectBatchOk(batch.body.results[0]);
    const second = expectBatchError(batch.body.results[1]);
    const third = expectBatchOk(batch.body.results[2]);
    expect(first.message).toMatchObject({ eventType: 'user.created', payload: { id: 20 } });
    expect(first.fanout).toMatchObject({ matched: 1, endpointIds: [endpoint.id] });
    expect(second.error.code).toBe('invalid_request');
    expect(third.message).toMatchObject({ eventType: 'invoice.paid', payload: { id: 'inv_20' } });
    expect(third.fanout).toMatchObject({ matched: 0, endpointIds: [] });
    expect(countMessages(storage, 'app_a')).toBe(2);
  });

  it('applies idempotency within a batch without duplicate fanout', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/batch-idempotent',
      eventTypes: ['user.created'],
    });

    const batch = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, [
      { eventType: 'user.created', payload: { id: 30 }, idempotencyKey: 'batch-same-key' },
      { eventType: 'user.created', payload: { id: 30 }, idempotencyKey: 'batch-same-key' },
      { eventType: 'user.created', payload: { id: 31 }, idempotencyKey: 'batch-same-key' },
    ]);

    expect(batch.status).toBe(200);
    const first = expectBatchOk(batch.body.results[0]);
    const second = expectBatchOk(batch.body.results[1]);
    const third = expectBatchError(batch.body.results[2]);
    expect(second).toEqual(first);
    expect(third.error).toEqual({
      code: 'idempotency_conflict',
      message: 'idempotencyKey was reused with a different request body.',
    });
    expect(countMessages(storage, 'app_a')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
  });

  it('applies deduplication within a batch without duplicate fanout', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/batch-deduped',
      eventTypes: ['user.created'],
    });

    const batch = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, [
      {
        eventType: 'user.created',
        payload: { id: 33 },
        deduplicationKey: 'batch-dedupe',
        deduplicationWindowSeconds: 3600,
      },
      {
        eventType: 'user.created',
        payload: { id: 33, noisy: true },
        deduplicationKey: 'batch-dedupe',
        deduplicationWindowSeconds: 3600,
      },
      { eventType: 'user.created', payload: {}, deduplicationWindowSeconds: 60 },
    ]);

    expect(batch.status).toBe(200);
    const first = expectBatchOk(batch.body.results[0]);
    const second = expectBatchOk(batch.body.results[1]);
    const third = expectBatchError(batch.body.results[2]);
    expect(second).toEqual(first);
    expect(third.error.code).toBe('invalid_request');
    expect(countMessages(storage, 'app_a')).toBe(1);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
    expect(countAcceptedMessages(storage, 'app_a')).toBe(1);
  });

  it('keeps batch retry fanout stable when endpoints change after the first send', async () => {
    const { address, storage } = await startSeededGateway();
    const originalEndpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/batch-original',
      eventTypes: ['payment.created'],
    }).endpoint;
    const body = [
      {
        eventType: 'payment.created',
        payload: { id: 'pay_batch_1' },
        idempotencyKey: 'batch-stable-fanout',
      },
    ];

    const first = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, body);
    const laterEndpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/batch-later',
      eventTypes: ['payment.created'],
    }).endpoint;
    const retry = await requestJson<BatchJson>(address, 'POST', '/v1/messages/batch', TENANT_A_KEY, body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const firstResult = expectBatchOk(first.body.results[0]);
    expect(firstResult.fanout.endpointIds).toEqual([originalEndpoint.id]);
    expect(firstResult.fanout.endpointIds).not.toContain(laterEndpoint.id);
    expect(countDeliveries(storage, 'app_a')).toBe(1);
  });

  it('lists tenant messages newest-first with keyset pagination', async () => {
    let nowMs = Date.parse('2026-06-12T12:00:00.000Z');
    const { address } = await startSeededGateway({ now: () => new Date(nowMs) });
    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'audit.created',
      payload: { id: 1 },
    });
    nowMs += 1000;
    const second = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'audit.created',
      payload: { id: 2 },
    });
    nowMs += 1000;
    const third = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'audit.created',
      payload: { id: 3 },
      idempotencyKey: 'history-secret-fields',
    });
    nowMs += 1000;
    await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_B_KEY, {
      eventType: 'audit.created',
      payload: { id: 'other-tenant' },
    });

    const firstPage = await requestJson<MessageListJson>(address, 'GET', '/v1/messages?limit=2', TENANT_A_KEY);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.map((message) => message.id)).toEqual([
      third.body.message.id,
      second.body.message.id,
    ]);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstPage.body)).not.toContain('history-secret-fields');
    expect(JSON.stringify(firstPage.body)).not.toContain('payload_hash');

    const secondPage = await requestJson<MessageListJson>(
      address,
      'GET',
      `/v1/messages?limit=2&cursor=${firstPage.body.nextCursor}`,
      TENANT_A_KEY,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toEqual([first.body.message]);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('filters tenant messages by event type and created-at windows with pagination', async () => {
    let nowMs = Date.parse('2026-06-12T12:00:00.000Z');
    const { address } = await startSeededGateway({ now: () => new Date(nowMs) });
    const first = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 1 },
    });
    nowMs += 60_000;
    const second = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 2 },
    });
    nowMs += 60_000;
    const third = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 3 },
      idempotencyKey: 'filtered-secret-fields',
    });
    nowMs += 60_000;
    await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_B_KEY, {
      eventType: 'user.created',
      payload: { id: 'other-tenant' },
    });
    const firstCreatedAtEastern = encodeURIComponent('2026-06-12T08:00:00-04:00');

    const firstPage = await requestJson<MessageListJson>(
      address,
      'GET',
      `/v1/messages?eventType=user.created&after=${firstCreatedAtEastern}&limit=1`,
      TENANT_A_KEY,
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.map((message) => message.id)).toEqual([third.body.message.id]);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstPage.body)).not.toContain('filtered-secret-fields');
    expect(JSON.stringify(firstPage.body)).not.toContain('payload_hash');

    const secondPage = await requestJson<MessageListJson>(
      address,
      'GET',
      `/v1/messages?eventType=user.created&after=${firstCreatedAtEastern}&limit=1&cursor=${firstPage.body.nextCursor}`,
      TENANT_A_KEY,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.map((message) => message.id)).toEqual([first.body.message.id]);
    expect(secondPage.body.nextCursor).toBeNull();

    const windowed = await requestJson<MessageListJson>(
      address,
      'GET',
      `/v1/messages?after=${encodeURIComponent(second.body.message.createdAt)}&before=${encodeURIComponent(third.body.message.createdAt)}`,
      TENANT_A_KEY,
    );
    expect(windowed.status).toBe(200);
    expect(windowed.body).toEqual({ data: [second.body.message], nextCursor: null });
  });

  it('keeps message history tenant-scoped and validates pagination parameters', async () => {
    const { address } = await startSeededGateway();
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'private.created',
      payload: { id: 4 },
    });

    const tenantA = await requestJson<MessageListJson>(address, 'GET', '/v1/messages', TENANT_A_KEY);
    const tenantB = await requestJson<MessageListJson>(address, 'GET', '/v1/messages', TENANT_B_KEY);
    const invalidLimit = await requestJson<ErrorJson>(address, 'GET', '/v1/messages?limit=0', TENANT_A_KEY);
    const invalidCursor = await requestJson<ErrorJson>(address, 'GET', '/v1/messages?cursor=bad', TENANT_A_KEY);
    const invalidEventType = await requestJson<ErrorJson>(address, 'GET', '/v1/messages?eventType=bad space', TENANT_A_KEY);
    const invalidAfter = await requestJson<ErrorJson>(address, 'GET', '/v1/messages?after=2026-06-12', TENANT_A_KEY);
    const invalidBefore = await requestJson<ErrorJson>(address, 'GET', '/v1/messages?before=not-a-date', TENANT_A_KEY);
    const invalidCalendarDate = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/messages?after=2026-02-30T00%3A00%3A00.000Z',
      TENANT_A_KEY,
    );
    const timezoneLessDate = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/messages?after=2026-06-12T12%3A00%3A00',
      TENANT_A_KEY,
    );
    const invertedWindow = await requestJson<ErrorJson>(
      address,
      'GET',
      '/v1/messages?after=2026-06-12T12%3A00%3A00.000Z&before=2026-06-12T12%3A00%3A00.000Z',
      TENANT_A_KEY,
    );
    const missingAuth = await fetch(`${address.url}/v1/messages`);
    const wrongMethod = await requestJson<ErrorJson>(address, 'PATCH', '/v1/messages', TENANT_A_KEY, {});

    expect(tenantA.status).toBe(200);
    expect(tenantA.body.data.map((message) => message.id)).toEqual([accepted.body.message.id]);
    expect(tenantB.status).toBe(200);
    expect(tenantB.body).toEqual({ data: [], nextCursor: null });
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimit.body.error.code).toBe('invalid_request');
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe('invalid_request');
    expect(invalidEventType.status).toBe(400);
    expect(invalidEventType.body.error.code).toBe('invalid_request');
    expect(invalidAfter.status).toBe(400);
    expect(invalidAfter.body.error.code).toBe('invalid_request');
    expect(invalidBefore.status).toBe(400);
    expect(invalidBefore.body.error.code).toBe('invalid_request');
    expect(invalidCalendarDate.status).toBe(400);
    expect(invalidCalendarDate.body.error.code).toBe('invalid_request');
    expect(timezoneLessDate.status).toBe(400);
    expect(timezoneLessDate.body.error.code).toBe('invalid_request');
    expect(invertedWindow.status).toBe(400);
    expect(invertedWindow.body.error.code).toBe('invalid_request');
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid bearer token.' } });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body).toEqual({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
  });

  it('returns successful delivery attempts for the authenticated tenant', async () => {
    const { address, storage } = await startSeededGateway();
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/success-attempts',
      eventTypes: ['user.created'],
    }).endpoint;
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 11 },
    });

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: async (url) => {
        expect(url).toBe(endpoint.url);
        return { status: 204 };
      },
    });
    const attempts = await requestJson<AttemptsPageJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}/attempts`,
      TENANT_A_KEY,
    );

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(attempts.status).toBe(200);
    expect(attempts.body.nextCursor).toBeNull();
    expect(attempts.body.data).toHaveLength(1);
    expect(attempts.body.data[0]).toEqual({
      id: expect.stringMatching(/^datt_/),
      deliveryId: accepted.body.fanout.deliveryIds[0],
      messageId: accepted.body.message.id,
      endpointId: endpoint.id,
      attemptNumber: 1,
      outcome: 'succeeded',
      attemptedAt: NOW.toISOString(),
      durationMs: expect.any(Number),
      responseStatus: 204,
      failureReason: null,
    });
  });

  it('returns message status with delivery rows for the authenticated tenant', async () => {
    const { address, storage } = await startSeededGateway();
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/status',
      eventTypes: ['user.created'],
    }).endpoint;
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.created',
      payload: { id: 14 },
    });

    const status = await requestJson<MessageStatusJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}`,
      TENANT_A_KEY,
    );
    const otherTenant = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}`,
      TENANT_B_KEY,
    );

    expect(status.status).toBe(200);
    expect(status.body.message).toEqual(accepted.body.message);
    expect(status.body.deliveries).toEqual([
      {
        id: accepted.body.fanout.deliveryIds[0],
        messageId: accepted.body.message.id,
        endpointId: endpoint.id,
        status: 'pending',
        attemptCount: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(otherTenant.status).toBe(404);
    expect(otherTenant.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('retries only tenant-owned dead-lettered deliveries with a fresh attempt budget', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/retry',
      eventTypes: ['invoice.failed'],
    });
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'invoice.failed',
      payload: { id: 'inv_14' },
    });

    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      fetch: async () => ({ status: 503 }),
    });
    const beforeRetry = await requestJson<MessageStatusJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}`,
      TENANT_A_KEY,
    );
    const retry = await requestJson<RetryJson>(
      address,
      'POST',
      `/v1/messages/${accepted.body.message.id}/retry`,
      TENANT_A_KEY,
    );
    const secondRetry = await requestJson<RetryJson>(
      address,
      'POST',
      `/v1/messages/${accepted.body.message.id}/retry`,
      TENANT_A_KEY,
    );
    const afterRetry = await requestJson<MessageStatusJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}`,
      TENANT_A_KEY,
    );
    const otherTenantRetry = await requestJson<ErrorJson>(
      address,
      'POST',
      `/v1/messages/${accepted.body.message.id}/retry`,
      TENANT_B_KEY,
    );
    const wrongMethod = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}/retry`,
      TENANT_A_KEY,
    );

    expect(beforeRetry.body.deliveries[0]).toMatchObject({ status: 'dead_letter', attemptCount: 1 });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ retried: 1 });
    expect(secondRetry.status).toBe(200);
    expect(secondRetry.body).toEqual({ retried: 0 });
    expect(afterRetry.body.deliveries[0]).toMatchObject({ status: 'pending', attemptCount: 0 });
    expect(otherTenantRetry.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body).toEqual({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
  });

  it('returns failed delivery attempts with response status and failure reason', async () => {
    const { address, storage } = await startSeededGateway();
    const endpoint = createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/failing-attempts',
      eventTypes: ['invoice.paid'],
    }).endpoint;
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'invoice.paid',
      payload: { id: 'inv_11' },
    });

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: async () => ({ status: 503 }),
    });
    const attempts = await requestJson<AttemptsPageJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}/attempts`,
      TENANT_A_KEY,
    );

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 0 });
    expect(attempts.status).toBe(200);
    expect(attempts.body.data).toEqual([
      {
        id: expect.stringMatching(/^datt_/),
        deliveryId: accepted.body.fanout.deliveryIds[0],
        messageId: accepted.body.message.id,
        endpointId: endpoint.id,
        attemptNumber: 1,
        outcome: 'failed',
        attemptedAt: NOW.toISOString(),
        durationMs: expect.any(Number),
        responseStatus: 503,
        failureReason: 'http_503',
      },
    ]);
  });

  it('paginates message attempts newest-first', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/paginated-attempts',
      eventTypes: ['user.updated'],
    });
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.updated',
      payload: { id: 12 },
    });
    let nowMs = NOW.getTime();
    const statuses = [500, 502, 200];
    const deliveryFetch: DeliveryFetch = async () => ({ status: statuses.shift() ?? 200 });

    await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      fetch: deliveryFetch,
    });
    nowMs += 1;
    await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      fetch: deliveryFetch,
    });
    nowMs += 1;
    await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      fetch: deliveryFetch,
    });

    const firstPage = await requestJson<AttemptsPageJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}/attempts?limit=2`,
      TENANT_A_KEY,
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.map((attempt) => attempt.attemptNumber)).toEqual([3, 2]);
    expect(firstPage.body.data.map((attempt) => attempt.responseStatus)).toEqual([200, 502]);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await requestJson<AttemptsPageJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}/attempts?limit=2&cursor=${firstPage.body.nextCursor}`,
      TENANT_A_KEY,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.map((attempt) => attempt.attemptNumber)).toEqual([1]);
    expect(secondPage.body.data[0]?.responseStatus).toBe(500);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('does not expose another tenant message attempts', async () => {
    const { address, storage } = await startSeededGateway();
    createEndpoint(storage, 'app_a', {
      url: 'https://example.com/hooks/private-attempts',
      eventTypes: ['user.deleted'],
    });
    const accepted = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, {
      eventType: 'user.deleted',
      payload: { id: 13 },
    });
    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: async () => ({ status: 204 }),
    });

    const otherTenant = await requestJson<ErrorJson>(
      address,
      'GET',
      `/v1/messages/${accepted.body.message.id}/attempts`,
      TENANT_B_KEY,
    );

    expect(otherTenant.status).toBe(404);
    expect(otherTenant.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });
});

async function startSeededGateway(
  options: { readonly now?: () => Date } = {},
): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
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
      ...(options.now === undefined ? {} : { now: options.now }),
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

function countAcceptedMessages(storage: PosthornStorage, appId: string): number {
  const row = storage.db
    .prepare('SELECT COALESCE(SUM(messages_accepted), 0) AS count FROM usage_months WHERE app_id = ?')
    .get(appId) as unknown as { readonly count: number };
  return Number(row.count);
}

async function expectMessageError(address: GatewayAddress, body: Record<string, unknown>): Promise<void> {
  const response = await requestJson<ErrorJson>(address, 'POST', '/v1/messages', TENANT_A_KEY, body);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('invalid_request');
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

function deeplyNestedPayload(): Record<string, unknown> {
  let payload: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 80; index += 1) {
    payload = { child: payload };
  }
  return payload;
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
