import { afterEach, describe, expect, it } from 'vitest';

import {
  createGateway,
  hashApiKey,
  IMPLEMENTED_ROUTES,
  POSTHORN_CLI_ROUTES,
  runPosthornCli,
  type CliStreams,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';
import { openStorage } from '../src/storage';

const TENANT_KEY = `phk_${Buffer.alloc(32, 61).toString('base64url')}`;

const activeGateways: Gateway[] = [];

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (gateway !== undefined) {
      await gateway.stop();
    }
  }
});

describe('posthorn client CLI', () => {
  it('prints help without requiring environment configuration', async () => {
    const io = captureStreams();
    const exitCode = await runPosthornCli(['client', 'help'], {}, { streams: io.streams });

    expect(exitCode).toBe(0);
    expect(io.stdout).toContain('posthorn client create-endpoint');
    expect(io.stdout).toContain('POSTHORN_URL');
    expect(io.stderr).toBe('');
  });

  it('runs common tenant operations against the HTTP gateway with JSON output', async () => {
    const { address } = await startSeededGateway();
    const env = cliEnv(address);

    const create = await runCli(['client', 'create-endpoint', 'https://example.com/hooks/cli', 'cli.created'], env);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(create.stdout) as {
      readonly endpoint: { readonly id: string; readonly url: string; readonly eventTypes: readonly string[] | null };
      readonly secret: string;
    };
    expect(created.endpoint).toMatchObject({
      url: 'https://example.com/hooks/cli',
      eventTypes: ['cli.created'],
    });
    expect(created.secret).toMatch(/^whsec_/);
    expect(create.stdout).not.toContain(TENANT_KEY);

    const sent = await runCli(['client', 'send', 'cli.created', '{"id":42}', '--idempotency-key', 'cli-42'], env);
    expect(sent.exitCode).toBe(0);
    const accepted = JSON.parse(sent.stdout) as { readonly message: { readonly id: string }; readonly fanout: { readonly matched: number } };
    expect(accepted.fanout.matched).toBe(1);

    const list = await runCli(['client', 'list-endpoints'], env);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ id: created.endpoint.id })]);

    const message = await runCli(['client', 'get-message', accepted.message.id], env);
    expect(JSON.parse(message.stdout)).toMatchObject({
      message: { id: accepted.message.id, eventType: 'cli.created', payload: { id: 42 } },
      deliveries: [{ status: 'pending', endpointId: created.endpoint.id }],
    });

    const usage = await runCli(['client', 'usage'], env);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      appId: 'app_cli',
      messagesAccepted: 1,
      deliveryAttempts: 0,
    });
  });

  it('prints actionable errors to stderr without leaking API keys', async () => {
    const { address } = await startSeededGateway();
    const env = cliEnv(address);

    const missingEnv = await runCli(['client', 'list-endpoints'], {});
    expect(missingEnv.exitCode).toBe(1);
    expect(missingEnv.stdout).toBe('');
    expect(missingEnv.stderr).toContain('Missing POSTHORN_URL or POSTHORN_API_KEY');

    const malformedPayload = await runCli(['client', 'send', 'cli.created', '{'], env);
    expect(malformedPayload.exitCode).toBe(1);
    expect(malformedPayload.stderr).toContain('Payload must be valid JSON.');

    const apiError = await runCli(['client', 'create-endpoint', 'http://127.0.0.1/hook'], env);
    expect(apiError.exitCode).toBe(1);
    expect(apiError.stdout).toBe('');
    expect(apiError.stderr).toContain('API error 400 (url_not_allowed):');
    expect(apiError.stderr).not.toContain(TENANT_KEY);
  });

  it('keeps CLI command routes covered by implemented OpenAPI routes', () => {
    const implemented = new Set(IMPLEMENTED_ROUTES.map(routeKey));
    const cliRoutes = new Set(POSTHORN_CLI_ROUTES.map(routeKey));

    expect(cliRoutes).toEqual(
      new Set([
        'POST /v1/endpoints',
        'POST /v1/messages',
        'GET /v1/endpoints',
        'GET /v1/messages/{id}',
        'GET /v1/usage',
      ]),
    );
    for (const route of cliRoutes) {
      expect(implemented.has(route), route).toBe(true);
    }
  });
});

async function startSeededGateway(): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_cli', 'CLI Tenant', TENANT_KEY);
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
    },
    {
      openStorage: () => storage,
      now: () => new Date('2026-06-12T12:00:00.000Z'),
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
      'CLI key',
      null,
      '2026-06-12T00:00:00.000Z',
    );
}

function cliEnv(address: GatewayAddress): Readonly<Record<string, string>> {
  return {
    POSTHORN_URL: address.url,
    POSTHORN_API_KEY: TENANT_KEY,
  };
}

async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const io = captureStreams();
  const exitCode = await runPosthornCli(argv, env, { streams: io.streams });
  return {
    exitCode,
    stdout: io.stdout,
    stderr: io.stderr,
  };
}

function captureStreams(): { readonly streams: CliStreams; readonly stdout: string; readonly stderr: string } {
  const output = { stdout: '', stderr: '' };
  return {
    get stdout() {
      return output.stdout;
    },
    get stderr() {
      return output.stderr;
    },
    streams: {
      stdout: {
        write(chunk: unknown) {
          output.stdout += String(chunk);
          return true;
        },
      } as CliStreams['stdout'],
      stderr: {
        write(chunk: unknown) {
          output.stderr += String(chunk);
          return true;
        },
      } as CliStreams['stderr'],
    },
  };
}

function routeKey(route: { readonly method: string; readonly path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
