import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acceptMessage,
  createEndpoint,
  hashApiKey,
  listDeliveriesForMessage,
  openStorage,
  rotateEndpointSecret,
  runDeliveryWorkerTick,
  verifyWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookVerificationError,
  type DeliveryFetch,
  type PosthornStorage,
} from '../src/index';

const APP_ID = 'app_worker';
const API_KEY = `phk_${Buffer.alloc(32, 21).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');

const activeReceivers: SyntheticReceiver[] = [];
const activeStorages: PosthornStorage[] = [];
const tempDirs: string[] = [];
let historicalDeliverySequence = 0;

interface RecordedRequest {
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface SyntheticReceiver {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  readonly errors: readonly Error[];
  close(): Promise<void>;
}

interface SyntheticResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface DeliveryRow {
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly lease_expires_at: string | null;
  readonly last_error: string | null;
}

interface AttemptRow {
  readonly attempt_number: number;
  readonly outcome: string;
  readonly response_status: number | null;
  readonly duration_ms: number;
  readonly failure_reason: string | null;
}

afterEach(async () => {
  while (activeReceivers.length > 0) {
    const receiver = activeReceivers.pop();
    if (receiver !== undefined) await receiver.close();
  }
  while (activeStorages.length > 0) {
    activeStorages.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('delivery worker', () => {
  it('sends signed webhooks, marks success, and records response status and duration', async () => {
    const storage = makeStorage();
    let endpointSecret = '';
    let expectedMessageId = '';
    const receiver = await startReceiver((request) => {
      expect(request.method).toBe('POST');
      verifyWebhook(endpointSecret, request.headers, request.body, {
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      });
      expect(request.headers['x-trace-id']).toBe('worker-success');
      expect(JSON.parse(request.body)).toEqual({
        id: expectedMessageId,
        eventType: 'user.created',
        payload: { id: 42 },
      });
      return { status: 204 };
    });
    const endpoint = createLocalEndpoint(storage, receiver.url, {
      eventTypes: ['user.created'],
      headers: { 'X-Trace-Id': 'worker-success' },
    });
    endpointSecret = endpoint.secret;
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.created',
      payload: { id: 42 },
    });
    expectedMessageId = message.message.id;

    const summary = await runDeliveryWorkerTick(storage, { now: () => NOW });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(receiver.errors).toEqual([]);
    expect(receiver.requests).toHaveLength(1);
    expect(listDeliveriesForMessage(storage, APP_ID, message.message.id)).toEqual([
      expect.objectContaining({
        endpointId: endpoint.endpoint.id,
        status: 'succeeded',
        attemptCount: 1,
      }),
    ]);
    expect(readAttempts(storage, message.fanout.deliveryIds[0])).toEqual([
      expect.objectContaining({
        attempt_number: 1,
        outcome: 'succeeded',
        response_status: 204,
        failure_reason: null,
      }),
    ]);
    expect(readAttempts(storage, message.fanout.deliveryIds[0])[0]?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('sends and signs only the original payload for payload_only endpoints', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/payload-only', {
      eventTypes: ['user.payload_only'],
      payloadFormat: 'payload_only',
    });
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.payload_only',
      payload: { id: 43, nested: { ok: true } },
    });
    const captured = createCapturingFetch();

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: captured.fetch,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(captured.request).not.toBeNull();
    if (captured.request === null) throw new Error('Expected captured delivery request.');
    expect(JSON.parse(captured.request.body)).toEqual({ id: 43, nested: { ok: true } });
    expect(captured.request.body).not.toContain(message.message.id);
    expect(captured.request.body).not.toContain('user.payload_only');
    verifyWebhook(endpoint.secret, captured.request.headers, captured.request.body, {
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });

  it('uses endpoint deliveryMethod while signing the exact selected body', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/put-payload-only', {
      eventTypes: ['user.put_payload_only'],
      deliveryMethod: 'PUT',
      payloadFormat: 'payload_only',
    });
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.put_payload_only',
      payload: { id: 44, nested: { ok: true } },
    });
    const captured = createCapturingFetch();

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: captured.fetch,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(captured.request).not.toBeNull();
    if (captured.request === null) throw new Error('Expected captured delivery request.');
    const request = captured.request;
    expect(request.method).toBe('PUT');
    expect(request.redirect).toBe('manual');
    expect(request.body).toBe(JSON.stringify({ id: 44, nested: { ok: true } }));
    verifyWebhook(endpoint.secret, request.headers, request.body, {
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
    expect(() =>
      verifyWebhook(endpoint.secret, request.headers, `${request.body}\n`, {
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      }),
    ).toThrow(WebhookVerificationError);
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });

  it('sends CloudEvents 1.0 JSON bodies and signs the exact body', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/cloud-events', {
      eventTypes: ['user.cloud_event'],
      deliveryMethod: 'PUT',
      payloadFormat: 'cloud_events_1_0',
    });
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.cloud_event',
      payload: { id: 45, nested: { ok: true } },
    }, NOW);
    const captured = createCapturingFetch();

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => new Date(NOW.getTime() + 1_000),
      fetch: captured.fetch,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(captured.request).not.toBeNull();
    if (captured.request === null) throw new Error('Expected captured delivery request.');
    const request = captured.request;
    expect(request.method).toBe('PUT');
    expect(request.redirect).toBe('manual');
    const expectedBody = JSON.stringify({
      specversion: '1.0',
      id: message.message.id,
      type: 'user.cloud_event',
      source: 'urn:posthorn',
      time: NOW.toISOString(),
      data: { id: 45, nested: { ok: true } },
    });
    expect(request.body).toBe(expectedBody);
    expect(JSON.parse(request.body)).toEqual({
      specversion: '1.0',
      id: message.message.id,
      type: 'user.cloud_event',
      source: 'urn:posthorn',
      time: NOW.toISOString(),
      data: { id: 45, nested: { ok: true } },
    });
    verifyWebhook(endpoint.secret, request.headers, request.body, {
      nowSeconds: Math.floor((NOW.getTime() + 1_000) / 1000),
    });
    expect(() =>
      verifyWebhook(endpoint.secret, request.headers, `${request.body}\n`, {
        nowSeconds: Math.floor((NOW.getTime() + 1_000) / 1000),
      }),
    ).toThrow(WebhookVerificationError);
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });

  it('signs deliveries with current and previous endpoint secrets during rotation overlap', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/rotation-overlap');
    const rotated = rotateEndpointSecret(storage, APP_ID, endpoint.endpoint.id, { overlapSeconds: 120 }, NOW);
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error('Expected endpoint rotation.');
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.created',
      payload: { id: 10 },
    });
    const attemptedAt = new Date(NOW.getTime() + 60_000);
    const captured = createCapturingFetch();

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => attemptedAt,
      fetch: captured.fetch,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(captured.request).not.toBeNull();
    if (captured.request === null) throw new Error('Expected captured delivery request.');
    const request = captured.request;
    expect(request.headers[WEBHOOK_SIGNATURE_HEADER]?.split(' ')).toHaveLength(2);
    verifyWebhook(rotated.secret, request.headers, request.body, {
      nowSeconds: Math.floor(attemptedAt.getTime() / 1000),
    });
    verifyWebhook(endpoint.secret, request.headers, request.body, {
      nowSeconds: Math.floor(attemptedAt.getTime() / 1000),
    });
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });

  it('stops signing with the previous endpoint secret after the rotation overlap expires', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/rotation-expired');
    const rotated = rotateEndpointSecret(storage, APP_ID, endpoint.endpoint.id, { overlapSeconds: 120 }, NOW);
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error('Expected endpoint rotation.');
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.created',
      payload: { id: 11 },
    });
    const attemptedAt = new Date(NOW.getTime() + 121_000);
    const captured = createCapturingFetch();

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => attemptedAt,
      fetch: captured.fetch,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(captured.request).not.toBeNull();
    if (captured.request === null) throw new Error('Expected captured delivery request.');
    const request = captured.request;
    expect(request.headers[WEBHOOK_SIGNATURE_HEADER]?.split(' ')).toHaveLength(1);
    verifyWebhook(rotated.secret, request.headers, request.body, {
      nowSeconds: Math.floor(attemptedAt.getTime() / 1000),
    });
    expect(() =>
      verifyWebhook(endpoint.secret, request.headers, request.body, {
        nowSeconds: Math.floor(attemptedAt.getTime() / 1000),
      }),
    ).toThrow(WebhookVerificationError);
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });

  it('fails closed when an active previous endpoint secret cannot be revealed', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/rotation-corrupt-previous');
    const rotated = rotateEndpointSecret(storage, APP_ID, endpoint.endpoint.id, { overlapSeconds: 120 }, NOW);
    expect(rotated).not.toBeNull();
    storage.db
      .prepare(
        `
          UPDATE endpoints
          SET previous_signing_secret_ciphertext = ?,
              previous_signing_secret_key_version = ?,
              previous_signing_secret_nonce = ?
          WHERE id = ?
        `,
      )
      .run('sha256:legacy', 'sha256-v1', '', endpoint.endpoint.id);
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.created',
      payload: { id: 12 },
    });
    const attemptedAt = new Date(NOW.getTime() + 60_000);
    let fetchCalled = false;

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => attemptedAt,
      attemptBudget: 1,
      fetch: async () => {
        fetchCalled = true;
        return { status: 204 };
      },
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(fetchCalled).toBe(false);
    expect(readDelivery(storage, message.fanout.deliveryIds[0])).toMatchObject({
      status: 'dead_letter',
      attempt_count: 1,
      last_error: 'signing_secret_unavailable',
    });
  });

  it('does not let concurrent ticks process the same active lease', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(async () => {
      await delay(75);
      return { status: 200 };
    });
    createLocalEndpoint(storage, receiver.url);
    acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 1 } });

    const first = runDeliveryWorkerTick(storage, {
      now: () => NOW,
      requestTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const second = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      requestTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const firstSummary = await first;

    expect(firstSummary.claimed).toBe(1);
    expect(second).toEqual({ claimed: 0, succeeded: 0, failed: 0, deadLettered: 0 });
    expect(receiver.requests).toHaveLength(1);
  });

  it('counts in-flight endpoint claims against the current throttle window', async () => {
    const storage = makeStorage();
    let releaseFetch: () => void = () => {
      throw new Error('Delivery fetch was not waiting.');
    };
    let markFetchStarted: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const deliveryFetch: DeliveryFetch = async () => {
      markFetchStarted?.();
      await new Promise<void>((release) => {
        releaseFetch = release;
      });
      return { status: 204 };
    };
    createLocalEndpoint(storage, 'https://example.com/webhooks/in-flight-throttle', {
      rateLimitPerSecond: 1,
    });
    acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 13 } }, NOW);
    acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 14 } }, NOW);

    const first = runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: deliveryFetch,
    });
    await fetchStarted;
    const second = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: async () => {
        throw new Error('Second tick should not send a throttled delivery.');
      },
    });
    expect(second).toEqual({ claimed: 0, succeeded: 0, failed: 0, deadLettered: 0 });
    releaseFetch();
    expect(await first).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
  });

  it('schedules retryable failures with exponential backoff and succeeds on a later due tick', async () => {
    const storage = makeStorage();
    let status = 503;
    let nowMs = NOW.getTime();
    const receiver = await startReceiver(() => ({ status }));
    createLocalEndpoint(storage, receiver.url);
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 2 } });
    const deliveryId = message.fanout.deliveryIds[0];

    const first = await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      baseBackoffMs: 1_000,
    });

    expect(first).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 0 });
    expect(readDelivery(storage, deliveryId)).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      next_attempt_at: new Date(NOW.getTime() + 1_000).toISOString(),
      last_error: 'http_503',
    });
    expect(await runDeliveryWorkerTick(storage, { now: () => new Date(nowMs), baseBackoffMs: 1_000 })).toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
    });

    status = 200;
    nowMs += 1_000;
    const retry = await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      baseBackoffMs: 1_000,
    });

    expect(retry).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(readDelivery(storage, deliveryId)).toMatchObject({
      status: 'succeeded',
      attempt_count: 2,
      next_attempt_at: null,
      last_error: null,
    });
    expect(readAttempts(storage, deliveryId).map((attempt) => attempt.outcome)).toEqual(['failed', 'succeeded']);
  });

  it('dead-letters after the configured attempt budget is exhausted', async () => {
    const storage = makeStorage();
    let nowMs = NOW.getTime();
    const receiver = await startReceiver(() => ({ status: 500 }));
    createLocalEndpoint(storage, receiver.url);
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 3 } });
    const deliveryId = message.fanout.deliveryIds[0];

    await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      attemptBudget: 2,
      baseBackoffMs: 10,
    });
    nowMs += 10;
    const second = await runDeliveryWorkerTick(storage, {
      now: () => new Date(nowMs),
      attemptBudget: 2,
      baseBackoffMs: 10,
    });

    expect(second).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(readDelivery(storage, deliveryId)).toMatchObject({
      status: 'dead_letter',
      attempt_count: 2,
      next_attempt_at: null,
      lease_expires_at: null,
      last_error: 'http_500',
    });
    expect(readAttempts(storage, deliveryId).map((attempt) => attempt.outcome)).toEqual(['failed', 'dead_letter']);
  });

  it('throttles endpoint delivery claims per second while other endpoints continue', async () => {
    const storage = makeStorage();
    const limitedEndpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/limited-throttle', {
      eventTypes: ['limited.created'],
      rateLimitPerSecond: 1,
    });
    const openEndpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/open-throttle', {
      eventTypes: ['open.created'],
    });
    const limitedFirst = acceptMessage(storage, APP_ID, { eventType: 'limited.created', payload: { id: 15 } }, NOW);
    const limitedSecond = acceptMessage(storage, APP_ID, { eventType: 'limited.created', payload: { id: 16 } }, NOW);
    const open = acceptMessage(storage, APP_ID, { eventType: 'open.created', payload: { id: 17 } }, NOW);

    const first = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      batchSize: 2,
      fetch: async () => ({ status: 204 }),
    });

    expect(first).toEqual({ claimed: 2, succeeded: 2, failed: 0, deadLettered: 0 });
    expect(readDelivery(storage, limitedFirst.fanout.deliveryIds[0])).toMatchObject({ status: 'succeeded' });
    expect(readDelivery(storage, limitedSecond.fanout.deliveryIds[0])).toMatchObject({ status: 'pending' });
    expect(readDelivery(storage, open.fanout.deliveryIds[0])).toMatchObject({ status: 'succeeded' });
    expect(limitedFirst.fanout.endpointIds).toEqual([limitedEndpoint.endpoint.id]);
    expect(open.fanout.endpointIds).toEqual([openEndpoint.endpoint.id]);

    const tooSoon = await runDeliveryWorkerTick(storage, {
      now: () => new Date(NOW.getTime() + 500),
      batchSize: 2,
      fetch: async () => {
        throw new Error('Throttle should leave the second limited delivery pending.');
      },
    });
    expect(tooSoon).toEqual({ claimed: 0, succeeded: 0, failed: 0, deadLettered: 0 });
    expect(readDelivery(storage, limitedSecond.fanout.deliveryIds[0])).toMatchObject({ status: 'pending' });

    const afterWindow = await runDeliveryWorkerTick(storage, {
      now: () => new Date(NOW.getTime() + 1_000),
      batchSize: 2,
      fetch: async () => ({ status: 204 }),
    });
    expect(afterWindow).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(readDelivery(storage, limitedSecond.fanout.deliveryIds[0])).toMatchObject({ status: 'succeeded' });
  });

  it('does not let exhausted throttled endpoints starve unthrottled endpoint claims', async () => {
    const storage = makeStorage();
    const exhaustedEndpointIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const endpoint = createLocalEndpoint(storage, `https://example.com/webhooks/exhausted-${index}`, {
        eventTypes: [`exhausted.${index}`],
        rateLimitPerSecond: 1,
      });
      exhaustedEndpointIds.push(endpoint.endpoint.id);
      storage.db
        .prepare(
          `
            UPDATE endpoints
            SET rate_limit_window_started_at = ?,
                rate_limit_window_count = ?
            WHERE id = ?
          `,
        )
        .run(NOW.toISOString(), 1, endpoint.endpoint.id);
      acceptMessage(
        storage,
        APP_ID,
        { eventType: `exhausted.${index}`, payload: { id: index } },
        new Date(NOW.getTime() - 1_000),
      );
    }
    const openEndpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/starvation-open', {
      eventTypes: ['starvation.open'],
    });
    const open = acceptMessage(storage, APP_ID, { eventType: 'starvation.open', payload: { id: 20 } }, NOW);
    const sentUrls: string[] = [];

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      batchSize: 1,
      fetch: async (url) => {
        sentUrls.push(url);
        return { status: 204 };
      },
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(sentUrls).toEqual(['https://example.com/webhooks/starvation-open']);
    expect(readDelivery(storage, open.fanout.deliveryIds[0])).toMatchObject({ status: 'succeeded' });
    expect(open.fanout.endpointIds).toEqual([openEndpoint.endpoint.id]);
    for (const endpointId of exhaustedEndpointIds) {
      expect(readEndpointThrottleState(storage, endpointId)).toEqual({
        rate_limit_window_started_at: NOW.toISOString(),
        rate_limit_window_count: 1,
      });
    }
  });

  it('auto-disables endpoints after the default sustained failure window and excludes future fanout', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(() => ({ status: 500 }));
    const endpoint = createLocalEndpoint(storage, receiver.url);
    seedHistoricalAttempt(storage, endpoint.endpoint.id, 'failed', new Date(NOW.getTime() - 432_000_001));
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 30 } });

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(readEndpointEnabled(storage, endpoint.endpoint.id)).toBe(false);
    expect(readDelivery(storage, message.fanout.deliveryIds[0])).toMatchObject({
      status: 'dead_letter',
      attempt_count: 1,
      last_error: 'http_500',
    });

    const afterDisable = acceptMessage(storage, APP_ID, {
      eventType: 'user.created',
      payload: { id: 31 },
    });
    expect(afterDisable.fanout.deliveryIds).toEqual([]);
  });

  it('does not auto-disable endpoints when the failure window is disabled', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(() => ({ status: 500 }));
    const endpoint = createLocalEndpoint(storage, receiver.url);
    seedHistoricalAttempt(storage, endpoint.endpoint.id, 'failed', new Date(NOW.getTime() - 5_000));
    acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 32 } });

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      endpointAutoDisableAfterMs: 0,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(readEndpointEnabled(storage, endpoint.endpoint.id)).toBe(true);
  });

  it('does not auto-disable from the current dead-letter alone', async () => {
    const storage = makeStorage();
    const endpoint = createLocalEndpoint(storage, 'https://example.com/webhooks/current-dead-letter-only');
    acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 35 } });
    const times = [
      new Date(NOW.getTime() - 2_000),
      new Date(NOW.getTime() + 2_000),
    ];

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => times.shift() ?? NOW,
      attemptBudget: 1,
      endpointAutoDisableAfterMs: 1_000,
      fetch: async () => ({ status: 500 }),
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(readEndpointEnabled(storage, endpoint.endpoint.id)).toBe(true);
  });

  it('does not auto-disable when a recent success resets the failure window', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(() => ({ status: 500 }));
    const endpoint = createLocalEndpoint(storage, receiver.url);
    seedHistoricalAttempt(storage, endpoint.endpoint.id, 'failed', new Date(NOW.getTime() - 2_000));
    seedHistoricalAttempt(storage, endpoint.endpoint.id, 'succeeded', new Date(NOW.getTime() - 500));
    acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 33 } });

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      endpointAutoDisableAfterMs: 1_000,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(readEndpointEnabled(storage, endpoint.endpoint.id)).toBe(true);
  });

  it('does not auto-disable from another endpoint or tenant failure history', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(() => ({ status: 500 }));
    const endpoint = createLocalEndpoint(storage, receiver.url, { eventTypes: ['user.current'] });
    storage.db
      .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
      .run('app_other_worker', 'Other Worker Tenant', null, NOW.toISOString());
    const otherEndpoint = createEndpoint(storage, 'app_other_worker', {
      url: 'https://example.com/webhooks/other-worker',
      eventTypes: ['user.current'],
    });
    seedHistoricalAttempt(storage, otherEndpoint.endpoint.id, 'failed', new Date(NOW.getTime() - 5_000));
    acceptMessage(storage, APP_ID, { eventType: 'user.current', payload: { id: 34 } });

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
      endpointAutoDisableAfterMs: 1_000,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(readEndpointEnabled(storage, endpoint.endpoint.id)).toBe(true);
    expect(readEndpointEnabled(storage, otherEndpoint.endpoint.id)).toBe(true);
  });

  it('times out slow receivers and leaves the task retryable', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(async () => {
      await delay(100);
      return { status: 200 };
    });
    createLocalEndpoint(storage, receiver.url);
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 4 } });
    const deliveryId = message.fanout.deliveryIds[0];

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      requestTimeoutMs: 20,
      baseBackoffMs: 5,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 0 });
    expect(readDelivery(storage, deliveryId)).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'timeout',
    });
    expect(readAttempts(storage, deliveryId)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        response_status: null,
        failure_reason: 'timeout',
      }),
    ]);
  });

  it('does not follow receiver redirects to another target', async () => {
    const storage = makeStorage();
    const redirectedTarget = await startReceiver(() => ({ status: 200 }));
    const redirectingReceiver = await startReceiver(() => ({
      status: 307,
      headers: { Location: redirectedTarget.url },
    }));
    createLocalEndpoint(storage, redirectingReceiver.url, { deliveryMethod: 'PUT' });
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 8 } });
    const deliveryId = message.fanout.deliveryIds[0];

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      baseBackoffMs: 5,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 0 });
    expect(redirectingReceiver.requests).toHaveLength(1);
    expect(redirectingReceiver.requests[0]?.method).toBe('PUT');
    expect(redirectedTarget.requests).toEqual([]);
    expect(readDelivery(storage, deliveryId)).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'http_307',
    });
  });

  it('cancels receiver response bodies instead of buffering them', async () => {
    const storage = makeStorage();
    createLocalEndpoint(storage, 'https://example.com/webhooks/custom-fetch');
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 9 } });
    let responseBodyCanceled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        responseBodyCanceled = true;
      },
    });
    const deliveryFetch: DeliveryFetch = async (_url, init) => {
      expect(init.redirect).toBe('manual');
      return { status: 200, body: responseBody };
    };

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      fetch: deliveryFetch,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(responseBodyCanceled).toBe(true);
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });

  it('reclaims expired leases and processes the task', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(() => ({ status: 200 }));
    createLocalEndpoint(storage, receiver.url);
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 5 } });
    const deliveryId = message.fanout.deliveryIds[0];
    storage.db
      .prepare('UPDATE deliveries SET status = ?, lease_expires_at = ? WHERE id = ?')
      .run('delivering', new Date(NOW.getTime() - 1).toISOString(), deliveryId);

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      visibilityTimeoutMs: 1_000,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(readDelivery(storage, deliveryId).status).toBe('succeeded');
    expect(receiver.requests).toHaveLength(1);
  });

  it('fails closed for legacy digest-only endpoint secrets instead of sending unsigned traffic', async () => {
    const storage = makeStorage();
    const receiver = await startReceiver(() => ({ status: 200 }));
    const endpoint = createLocalEndpoint(storage, receiver.url);
    storage.db
      .prepare(
        `
          UPDATE endpoints
          SET signing_secret_ciphertext = ?, signing_secret_key_version = ?, signing_secret_nonce = ?
          WHERE id = ?
        `,
      )
      .run('sha256:legacy', 'sha256-v1', '', endpoint.endpoint.id);
    const message = acceptMessage(storage, APP_ID, { eventType: 'user.created', payload: { id: 6 } });
    const deliveryId = message.fanout.deliveryIds[0];

    const summary = await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 1,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deadLettered: 1 });
    expect(receiver.requests).toEqual([]);
    expect(readDelivery(storage, deliveryId)).toMatchObject({
      status: 'dead_letter',
      attempt_count: 1,
      last_error: 'signing_secret_unavailable',
    });
  });

  it('can reveal endpoint signing secrets after file-backed storage is reopened', async () => {
    const dataDir = makeTempDir();
    let storage = openTrackedStorage(dataDir);
    seedApp(storage);
    let endpointSecret = '';
    let expectedMessageId = '';
    const receiver = await startReceiver((request) => {
      verifyWebhook(endpointSecret, request.headers, request.body, {
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      });
      expect(JSON.parse(request.body)).toMatchObject({ id: expectedMessageId });
      return { status: 200 };
    });
    const endpoint = createEndpoint(storage, APP_ID, {
      url: 'https://example.com/webhooks/reopened',
      eventTypes: ['user.created'],
    });
    endpointSecret = endpoint.secret;
    closeTrackedStorage(storage);

    storage = openTrackedStorage(dataDir);
    storage.db.prepare('UPDATE endpoints SET url = ? WHERE id = ?').run(receiver.url, endpoint.endpoint.id);
    const message = acceptMessage(storage, APP_ID, {
      eventType: 'user.created',
      payload: { id: 7 },
    });
    expectedMessageId = message.message.id;

    const summary = await runDeliveryWorkerTick(storage, { now: () => NOW });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(receiver.errors).toEqual([]);
    expect(readDelivery(storage, message.fanout.deliveryIds[0]).status).toBe('succeeded');
  });
});

function makeStorage(): PosthornStorage {
  const storage = openTrackedStorage(':memory:');
  seedApp(storage);
  return storage;
}

function openTrackedStorage(dataDir: string): PosthornStorage {
  const storage = openStorage({ dataDir });
  activeStorages.push(storage);
  return storage;
}

function closeTrackedStorage(storage: PosthornStorage): void {
  const index = activeStorages.indexOf(storage);
  if (index >= 0) activeStorages.splice(index, 1);
  storage.close();
}

function seedApp(storage: PosthornStorage): void {
  storage.db
    .prepare('INSERT INTO apps (id, name, monthly_message_quota, created_at) VALUES (?, ?, ?, ?)')
    .run(APP_ID, 'Worker Tenant', null, NOW.toISOString());
  storage.db
    .prepare('INSERT INTO api_keys (id, app_id, key_hash, name, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('ak_worker', APP_ID, hashApiKey(API_KEY), 'Worker key', null, NOW.toISOString());
}

function createLocalEndpoint(
  storage: PosthornStorage,
  url: string,
  input: {
    readonly eventTypes?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
    readonly rateLimitPerSecond?: number | null;
    readonly deliveryMethod?: 'POST' | 'PUT' | null;
    readonly payloadFormat?: 'envelope' | 'payload_only' | 'cloud_events_1_0' | null;
  } = {},
): ReturnType<typeof createEndpoint> {
  const endpoint = createEndpoint(storage, APP_ID, {
    url: 'https://example.com/webhooks/worker',
    ...input,
  });
  storage.db.prepare('UPDATE endpoints SET url = ? WHERE id = ?').run(url, endpoint.endpoint.id);
  return endpoint;
}

function createCapturingFetch(): {
  readonly fetch: DeliveryFetch;
  request: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly redirect: string } | null;
} {
  const captured: {
    readonly fetch: DeliveryFetch;
    request: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly redirect: string } | null;
  } = {
    request: null,
    fetch: async (_url, init) => {
      captured.request = {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: init.redirect,
      };
      return { status: 204 };
    },
  };
  return captured;
}

async function startReceiver(
  handler: (request: RecordedRequest) => Promise<SyntheticResponse> | SyntheticResponse,
): Promise<SyntheticReceiver> {
  const requests: RecordedRequest[] = [];
  const errors: Error[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      void (async () => {
        const recorded = {
          method: request.method ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(recorded);

        try {
          const result = await handler(recorded);
          response.writeHead(result.status, result.headers);
          if (result.body !== undefined) {
            response.write(result.body);
          }
        } catch (error) {
          errors.push(asError(error));
          response.writeHead(500);
        }
        response.end();
      })();
    });
  });

  const address = await listen(server);
  const receiver = Object.freeze({
    url: `http://127.0.0.1:${address.port}/webhook`,
    requests,
    errors,
    close: () => closeServer(server),
  });
  activeReceivers.push(receiver);
  return receiver;
}

function readDelivery(storage: PosthornStorage, deliveryId: string): DeliveryRow {
  return storage.db
    .prepare('SELECT status, attempt_count, next_attempt_at, lease_expires_at, last_error FROM deliveries WHERE id = ?')
    .get(deliveryId) as unknown as DeliveryRow;
}

function readEndpointEnabled(storage: PosthornStorage, endpointId: string): boolean {
  const row = storage.db.prepare('SELECT enabled FROM endpoints WHERE id = ?').get(endpointId) as
    | { readonly enabled: unknown }
    | undefined;
  if (row === undefined) throw new Error(`Missing endpoint ${endpointId}.`);
  return Number(row.enabled) === 1;
}

function readEndpointThrottleState(
  storage: PosthornStorage,
  endpointId: string,
): {
  readonly rate_limit_window_started_at: string | null;
  readonly rate_limit_window_count: number;
} {
  const row = storage.db
    .prepare('SELECT rate_limit_window_started_at, rate_limit_window_count FROM endpoints WHERE id = ?')
    .get(endpointId) as
    | { readonly rate_limit_window_started_at: string | null; readonly rate_limit_window_count: number }
    | undefined;
  if (row === undefined) throw new Error(`Missing endpoint ${endpointId}.`);
  return row;
}

function seedHistoricalAttempt(
  storage: PosthornStorage,
  endpointId: string,
  outcome: 'failed' | 'dead_letter' | 'succeeded',
  attemptedAt: Date,
): void {
  const endpoint = storage.db.prepare('SELECT app_id FROM endpoints WHERE id = ?').get(endpointId) as
    | { readonly app_id: unknown }
    | undefined;
  if (endpoint === undefined) throw new Error(`Missing endpoint ${endpointId}.`);

  historicalDeliverySequence += 1;
  const suffix = `${historicalDeliverySequence}`;
  const messageId = `msg_worker_history_${suffix}`;
  const deliveryId = `del_worker_history_${suffix}`;
  const attemptId = `datt_worker_history_${suffix}`;
  const attemptedAtIso = attemptedAt.toISOString();
  storage.db
    .prepare(
      `
        INSERT INTO messages (id, app_id, event_type, payload_json, idempotency_key, payload_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(messageId, String(endpoint.app_id), 'worker.history', '{}', null, null, attemptedAtIso);
  storage.db
    .prepare(
      `
        INSERT INTO deliveries (
          id,
          message_id,
          endpoint_id,
          status,
          attempt_count,
          next_attempt_at,
          lease_expires_at,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      deliveryId,
      messageId,
      endpointId,
      outcome === 'succeeded' ? 'succeeded' : 'dead_letter',
      1,
      null,
      null,
      outcome === 'succeeded' ? null : 'http_500',
      attemptedAtIso,
      attemptedAtIso,
    );
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
      attemptId,
      deliveryId,
      1,
      outcome,
      outcome === 'succeeded' ? 204 : 500,
      1,
      outcome === 'succeeded' ? null : 'http_500',
      attemptedAtIso,
    );
}

function readAttempts(storage: PosthornStorage, deliveryId: string): readonly AttemptRow[] {
  return storage.db
    .prepare(
      `
        SELECT attempt_number, outcome, response_status, duration_ms, failure_reason
        FROM delivery_attempts
        WHERE delivery_id = ?
        ORDER BY attempt_number ASC
      `,
    )
    .all(deliveryId) as unknown as AttemptRow[];
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'posthorn-worker-'));
  tempDirs.push(dir);
  return dir;
}
