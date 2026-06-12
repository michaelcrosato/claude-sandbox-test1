import { afterEach, describe, expect, it } from 'vitest';

import {
  createEndpoint,
  createGateway,
  hashApiKey,
  openStorage,
  runDeliveryWorkerTick,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 71).toString('base64url')}`;
const OTHER_TENANT_KEY = `phk_${Buffer.alloc(32, 72).toString('base64url')}`;
const NOW = new Date('2026-06-12T12:00:00.000Z');
const LATER = new Date('2026-06-12T12:02:03.000Z');

const activeGateways: Gateway[] = [];

interface AcceptedMessageJson {
  readonly message: {
    readonly id: string;
  };
  readonly fanout: {
    readonly deliveryIds: readonly string[];
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

describe('Prometheus metrics endpoint', () => {
  it('returns bounded Prometheus metrics derived from message and delivery state', async () => {
    const { address, storage, setNow } = await startSeededGateway();
    const successEndpoint = createEndpoint(storage, 'app_metrics', {
      url: 'https://example.com/hooks/success',
      eventTypes: ['metrics.success'],
      headers: { 'X-Trace-Id': 'safe-header' },
    }).endpoint;
    createEndpoint(storage, 'app_metrics', {
      url: 'https://example.com/hooks/retry',
      eventTypes: ['metrics.retry'],
    });
    createEndpoint(storage, 'app_metrics', {
      url: 'https://example.com/hooks/dead',
      eventTypes: ['metrics.dead'],
    });

    const success = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'metrics.success',
      payload: { id: 1, secret: 'payload-should-not-leak' },
    });
    const retrying = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'metrics.retry',
      payload: { id: 2 },
    });
    const deadLettered = await requestJson<AcceptedMessageJson>(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'metrics.dead',
      payload: { id: 3 },
    });

    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 2,
      fetch: async (url) => {
        if (url === successEndpoint.url) return { status: 204 };
        return { status: 503 };
      },
      baseBackoffMs: 10_000,
      maxBackoffMs: 10_000,
    });
    storage.db
      .prepare('UPDATE deliveries SET next_attempt_at = ? WHERE id = ?')
      .run(NOW.toISOString(), deadLettered.fanout.deliveryIds[0]);
    await runDeliveryWorkerTick(storage, {
      now: () => NOW,
      attemptBudget: 2,
      fetch: async () => ({ status: 503 }),
    });

    setNow(LATER);
    const response = await fetch(`${address.url}/metrics`);
    const body = await response.text();
    const lines = body.trimEnd().split('\n');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(body.endsWith('\n')).toBe(true);
    expect(lines).toContain('# HELP posthorn_messages_ingested_total Total accepted messages.');
    expect(lines).toContain('# TYPE posthorn_messages_ingested_total counter');
    expect(lines).toContain('posthorn_messages_ingested_total 3');
    expect(lines).toContain('posthorn_deliveries_total{outcome="succeeded"} 1');
    expect(lines).toContain('posthorn_deliveries_total{outcome="retrying"} 2');
    expect(lines).toContain('posthorn_deliveries_total{outcome="dead_lettered"} 1');
    expect(lines).toContain('posthorn_delivery_tasks{status="pending"} 1');
    expect(lines).toContain('posthorn_delivery_tasks{status="delivering"} 0');
    expect(lines).toContain('posthorn_delivery_tasks{status="succeeded"} 1');
    expect(lines).toContain('posthorn_delivery_tasks{status="dead_letter"} 1');
    expect(lines).toContain('posthorn_dead_letter_tasks{reason="http_###"} 1');
    expect(lines).toContain('posthorn_uptime_seconds 123');
    expect(lines).toContain('posthorn_build_info{version="0.0.0"} 1');
    expectMetricNamesAndLabelsAreDocumented(lines);
    expect(body).not.toContain('app_metrics');
    expect(body).not.toContain('app_other');
    expect(body).not.toContain(successEndpoint.id);
    expect(body).not.toContain(successEndpoint.url);
    expect(body).not.toContain(success.message.id);
    expect(body).not.toContain(retrying.fanout.deliveryIds[0]);
    expect(body).not.toContain(deadLettered.fanout.deliveryIds[0]);
    expect(body).not.toContain(TENANT_KEY);
    expect(body).not.toContain('whsec_');
    expect(body).not.toContain('sha256:');
    expect(body).not.toContain('payload-should-not-leak');
    expect(body).not.toContain('metrics.success');
    expect(body).not.toContain('safe-header');
  });

  it('is unauthenticated, rejects unsupported methods, and reports storage readiness errors safely', async () => {
    const { address } = await startSeededGateway();
    const noAuth = await fetch(`${address.url}/metrics`);
    const unsupported = await fetch(`${address.url}/metrics`, { method: 'POST' });
    const readinessFailure = await startGatewayWithReadinessError();
    const unavailable = await fetch(`${readinessFailure.address.url}/metrics`);
    const probeFailure = await startGatewayWithProbeError();
    const probeUnavailable = await fetch(`${probeFailure.address.url}/metrics`);

    expect(noAuth.status).toBe(200);
    expect(unsupported.status).toBe(405);
    expect((await unsupported.json()) as ErrorJson).toEqual({
      error: { code: 'method_not_allowed', message: 'Method not allowed.' },
    });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()) as ErrorJson).toEqual({
      error: { code: 'internal_error', message: 'Storage is not ready.' },
    });
    expect(probeUnavailable.status).toBe(503);
    expect((await probeUnavailable.json()) as ErrorJson).toEqual({
      error: { code: 'internal_error', message: 'Storage is not ready.' },
    });
  });
});

async function startSeededGateway(): Promise<{
  address: GatewayAddress;
  storage: PosthornStorage;
  setNow: (value: Date) => void;
}> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_metrics', 'Metrics Tenant', TENANT_KEY);
  seedTenant(storage, 'app_other', 'Other Tenant', OTHER_TENANT_KEY);
  let currentTime = NOW;
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
    },
    {
      openStorage: () => storage,
      now: () => currentTime,
    },
  );
  activeGateways.push(gateway);
  return {
    address: await gateway.start(),
    storage,
    setNow(value: Date) {
      currentTime = value;
    },
  };
}

async function startGatewayWithReadinessError(): Promise<{ address: GatewayAddress }> {
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
    },
    {
      openStorage: () => {
        throw new Error('synthetic storage failure');
      },
      now: () => LATER,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start() };
}

async function startGatewayWithProbeError(): Promise<{ address: GatewayAddress }> {
  const storage = openStorage({ dataDir: ':memory:' });
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
    },
    {
      openStorage: () => storage,
      readinessProbe: () => {
        throw new Error('synthetic probe failure');
      },
      now: () => LATER,
    },
  );
  activeGateways.push(gateway);
  return { address: await gateway.start() };
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
      'Metrics key',
      null,
      '2026-06-12T00:00:00.000Z',
    );
}

async function requestJson<T>(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as T;
}

function expectMetricNamesAndLabelsAreDocumented(lines: readonly string[]): void {
  const allowed = new Map<string, readonly string[]>([
    ['posthorn_messages_ingested_total', []],
    ['posthorn_deliveries_total', ['outcome']],
    ['posthorn_delivery_tasks', ['status']],
    ['posthorn_dead_letter_tasks', ['reason']],
    ['posthorn_uptime_seconds', []],
    ['posthorn_build_info', ['version']],
  ]);

  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})? /.exec(line);
    expect(match, line).not.toBeNull();
    if (match === null) continue;
    const [, name, rawLabels] = match;
    expect(allowed.has(name), line).toBe(true);
    const labelNames =
      rawLabels === undefined || rawLabels === ''
        ? []
        : rawLabels.split(',').map((label) => label.slice(0, label.indexOf('=')));
    expect(labelNames.sort(), line).toEqual([...(allowed.get(name) ?? [])].sort());
  }
}
