import { afterEach, describe, expect, it } from 'vitest';

import {
  createGateway,
  hashApiKey,
  IMPLEMENTED_ROUTES,
  POSTHORN_ADMIN_CLI_ROUTES,
  POSTHORN_CLI_ROUTES,
  runPosthornCli,
  type CliStreams,
  type Gateway,
  type GatewayAddress,
  type PosthornStorage,
} from '../src/index';
import { openStorage } from '../src/storage';

const ADMIN_TOKEN = '0123456789abcdef';
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
    expect(io.stdout).toContain('--rate-limit-per-second');
    expect(io.stdout).toContain('--delivery-method');
    expect(io.stdout).toContain('--payload-format');
    expect(io.stdout).toContain('--deduplication-key');
    expect(io.stdout).toContain('POSTHORN_URL');
    expect(io.stderr).toBe('');
  });

  it('prints admin help without requiring environment configuration', async () => {
    const io = captureStreams();
    const exitCode = await runPosthornCli(['admin', 'help'], {}, { streams: io.streams });

    expect(exitCode).toBe(0);
    expect(io.stdout).toContain('posthorn admin create-app');
    expect(io.stdout).toContain('posthorn admin rotate-system-secret');
    expect(io.stdout).toContain('POSTHORN_ADMIN_TOKEN');
    expect(io.stderr).toBe('');
  });

  it('runs common tenant operations against the HTTP gateway with JSON output', async () => {
    const { address } = await startSeededGateway();
    const env = cliEnv(address);

    const create = await runCli(
      [
        'client',
        'create-endpoint',
        'https://example.com/hooks/cli',
        'cli.created',
        '--rate-limit-per-second',
        '2',
        '--delivery-method',
        'PUT',
        '--payload-format',
        'payload_only',
      ],
      env,
    );
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(create.stdout) as {
      readonly endpoint: {
        readonly id: string;
        readonly url: string;
        readonly eventTypes: readonly string[] | null;
        readonly rateLimitPerSecond: number | null;
        readonly deliveryMethod: string;
        readonly payloadFormat: string;
      };
      readonly secret: string;
    };
    expect(created.endpoint).toMatchObject({
      url: 'https://example.com/hooks/cli',
      eventTypes: ['cli.created'],
      rateLimitPerSecond: 2,
      deliveryMethod: 'PUT',
      payloadFormat: 'payload_only',
    });
    expect(created.secret).toMatch(/^whsec_/);
    expect(create.stdout).not.toContain(TENANT_KEY);

    const sent = await runCli(
      [
        'client',
        'send',
        'cli.created',
        '{"id":42}',
        '--deduplication-key',
        'cli-42',
        '--deduplication-window-seconds',
        '60',
      ],
      env,
    );
    expect(sent.exitCode).toBe(0);
    const accepted = JSON.parse(sent.stdout) as { readonly message: { readonly id: string }; readonly fanout: { readonly matched: number } };
    expect(accepted.fanout.matched).toBe(1);

    const list = await runCli(['client', 'list-endpoints'], env);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ id: created.endpoint.id })]);

    const cloudEventsCreate = await runCli(
      ['client', 'create-endpoint', 'https://example.com/hooks/cli-cloud', 'cli.cloud', '--payload-format', 'cloud_events_1_0'],
      env,
    );
    expect(cloudEventsCreate.exitCode).toBe(0);
    expect(JSON.parse(cloudEventsCreate.stdout).endpoint.payloadFormat).toBe('cloud_events_1_0');

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

    const malformedRateLimit = await runCli(
      ['client', 'create-endpoint', 'https://example.com/hooks/cli', '--rate-limit-per-second', 'abc'],
      env,
    );
    expect(malformedRateLimit.exitCode).toBe(1);
    expect(malformedRateLimit.stderr).toContain('--rate-limit-per-second requires a positive safe integer.');
    expect(malformedRateLimit.stderr).not.toContain(TENANT_KEY);

    const malformedPayloadFormat = await runCli(
      ['client', 'create-endpoint', 'https://example.com/hooks/cli', '--payload-format', 'payload'],
      env,
    );
    expect(malformedPayloadFormat.exitCode).toBe(1);
    expect(malformedPayloadFormat.stderr).toContain('--payload-format requires envelope or payload_only.');
    expect(malformedPayloadFormat.stderr).toContain('cloud_events_1_0');
    expect(malformedPayloadFormat.stderr).not.toContain(TENANT_KEY);

    const malformedDeliveryMethod = await runCli(
      ['client', 'create-endpoint', 'https://example.com/hooks/cli', '--delivery-method', 'PATCH'],
      env,
    );
    expect(malformedDeliveryMethod.exitCode).toBe(1);
    expect(malformedDeliveryMethod.stderr).toContain('--delivery-method requires POST or PUT.');
    expect(malformedDeliveryMethod.stderr).not.toContain(TENANT_KEY);

    const malformedDeduplicationWindow = await runCli(
      ['client', 'send', 'cli.created', '{"id":42}', '--deduplication-key', 'cli-42', '--deduplication-window-seconds', 'abc'],
      env,
    );
    expect(malformedDeduplicationWindow.exitCode).toBe(1);
    expect(malformedDeduplicationWindow.stderr).toContain('--deduplication-window-seconds requires a positive safe integer.');
    expect(malformedDeduplicationWindow.stderr).not.toContain(TENANT_KEY);

    const tokenAsCreateEndpointOption = await runCli(
      ['client', 'create-endpoint', 'https://example.com/hooks/cli', '--bogus', TENANT_KEY],
      env,
    );
    expect(tokenAsCreateEndpointOption.exitCode).toBe(1);
    expect(tokenAsCreateEndpointOption.stderr).toContain('Unknown option for create-endpoint.');
    expect(tokenAsCreateEndpointOption.stderr).not.toContain(TENANT_KEY);

    const apiError = await runCli(['client', 'create-endpoint', 'http://127.0.0.1/hook'], env);
    expect(apiError.exitCode).toBe(1);
    expect(apiError.stdout).toBe('');
    expect(apiError.stderr).toContain('API error 400 (url_not_allowed):');
    expect(apiError.stderr).not.toContain(TENANT_KEY);
  });

  it('runs common admin operations against the HTTP gateway with JSON output', async () => {
    const { address } = await startAdminGateway();
    const env = adminCliEnv(address);

    const create = await runCli(
      ['admin', 'create-app', 'Admin Tenant', '--monthly-message-quota', '10'],
      env,
    );
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(create.stdout) as {
      readonly app: {
        readonly id: string;
        readonly name: string;
        readonly monthlyMessageQuota: number | null;
      };
    };
    expect(created.app).toMatchObject({
      id: expect.stringMatching(/^app_/),
      name: 'Admin Tenant',
      monthlyMessageQuota: 10,
    });
    expect(create.stdout).not.toContain(ADMIN_TOKEN);

    const list = await runCli(['admin', 'list-apps'], env);
    expect(JSON.parse(list.stdout)).toEqual([created.app]);

    const read = await runCli(['admin', 'get-app', created.app.id], env);
    expect(JSON.parse(read.stdout)).toEqual({ app: created.app });

    const updated = await runCli(
      ['admin', 'update-app', created.app.id, '--name', 'Admin Tenant Plus', '--monthly-message-quota', 'null'],
      env,
    );
    expect(JSON.parse(updated.stdout)).toEqual({
      app: {
        ...created.app,
        name: 'Admin Tenant Plus',
        monthlyMessageQuota: null,
      },
    });

    const key = await runCli(['admin', 'create-key', created.app.id, 'Primary'], env);
    expect(key.exitCode).toBe(0);
    const createdKey = JSON.parse(key.stdout) as {
      readonly apiKey: { readonly id: string; readonly appId: string; readonly name: string | null };
      readonly secret: string;
    };
    expect(createdKey).toMatchObject({
      apiKey: {
        id: expect.stringMatching(/^ak_/),
        appId: created.app.id,
        name: 'Primary',
      },
      secret: expect.stringMatching(/^phk_/),
    });
    expect(key.stdout).not.toContain(ADMIN_TOKEN);

    const keys = await runCli(['admin', 'list-keys', created.app.id], env);
    expect(JSON.parse(keys.stdout)).toEqual([createdKey.apiKey]);
    expect(keys.stdout).not.toContain(createdKey.secret);

    const usage = await runCli(['admin', 'usage', created.app.id], env);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      appId: created.app.id,
      messagesAccepted: 0,
      deliveryAttempts: 0,
      quota: {
        monthlyMessageQuota: null,
        remaining: null,
        exceeded: false,
      },
    });

    const rotated = await runCli(['admin', 'rotate-system-secret', created.app.id, '--overlap-seconds', '120'], env);
    expect(JSON.parse(rotated.stdout)).toMatchObject({
      app: {
        ...created.app,
        name: 'Admin Tenant Plus',
        monthlyMessageQuota: null,
      },
      secret: expect.stringMatching(/^whsec_/),
      previousSecretExpiresAt: null,
    });
    expect(rotated.stdout).not.toContain(ADMIN_TOKEN);

    const revoked = await runCli(['admin', 'revoke-key', createdKey.apiKey.id], env);
    expect(JSON.parse(revoked.stdout)).toEqual({ revoked: true });

    const deleted = await runCli(['admin', 'delete-app', created.app.id], env);
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true });
    const afterDelete = await runCli(['admin', 'list-apps'], env);
    expect(JSON.parse(afterDelete.stdout)).toEqual([]);
  });

  it('prints actionable admin errors to stderr without leaking admin tokens or one-time secrets', async () => {
    const { address } = await startAdminGateway();
    const env = adminCliEnv(address);

    const missingEnv = await runCli(['admin', 'list-apps'], {});
    expect(missingEnv.exitCode).toBe(1);
    expect(missingEnv.stdout).toBe('');
    expect(missingEnv.stderr).toContain('Missing POSTHORN_URL or POSTHORN_ADMIN_TOKEN');

    const malformedQuota = await runCli(['admin', 'create-app', 'Bad Tenant', '--monthly-message-quota', 'abc'], env);
    expect(malformedQuota.exitCode).toBe(1);
    expect(malformedQuota.stderr).toContain('--monthly-message-quota requires a non-negative safe integer or null.');
    expect(malformedQuota.stderr).not.toContain(ADMIN_TOKEN);

    const missingUpdateFields = await runCli(['admin', 'update-app', 'app_missing'], env);
    expect(missingUpdateFields.exitCode).toBe(1);
    expect(missingUpdateFields.stderr).toContain('update-app requires --name or --monthly-message-quota.');
    expect(missingUpdateFields.stderr).not.toContain(ADMIN_TOKEN);

    const tokenAsCommand = await runCli(['admin', ADMIN_TOKEN], env);
    expect(tokenAsCommand.exitCode).toBe(1);
    expect(tokenAsCommand.stderr).toContain('Unknown admin command.');
    expect(tokenAsCommand.stderr).not.toContain(ADMIN_TOKEN);

    const tokenAsOption = await runCli(['admin', 'update-app', 'app_missing', ADMIN_TOKEN], env);
    expect(tokenAsOption.exitCode).toBe(1);
    expect(tokenAsOption.stderr).toContain('Unknown option for update-app.');
    expect(tokenAsOption.stderr).not.toContain(ADMIN_TOKEN);

    const malformedOverlap = await runCli(['admin', 'rotate-system-secret', 'app_missing', '--overlap-seconds', 'abc'], env);
    expect(malformedOverlap.exitCode).toBe(1);
    expect(malformedOverlap.stderr).toContain('--overlap-seconds requires a non-negative safe integer.');

    const createKeyUnknownOption = await runCli(['admin', 'create-key', 'app_missing', '--bogus'], env);
    expect(createKeyUnknownOption.exitCode).toBe(1);
    expect(createKeyUnknownOption.stderr).toContain('Unknown option for create-key.');
    expect(createKeyUnknownOption.stderr).not.toContain('--bogus');

    const app = JSON.parse((await runCli(['admin', 'create-app', 'Secret Tenant'], env)).stdout) as {
      readonly app: { readonly id: string };
    };
    const key = JSON.parse((await runCli(['admin', 'create-key', app.app.id], env)).stdout) as {
      readonly secret: string;
    };
    const secretAsOption = await runCli(['admin', 'rotate-system-secret', app.app.id, key.secret], env);
    expect(secretAsOption.exitCode).toBe(1);
    expect(secretAsOption.stderr).toContain('Unknown option for rotate-system-secret.');
    expect(secretAsOption.stderr).not.toContain(key.secret);

    const apiError = await runCli(['admin', 'get-app', app.app.id], {
      POSTHORN_URL: address.url,
      POSTHORN_ADMIN_TOKEN: 'wrong-admin-token',
    });
    expect(apiError.exitCode).toBe(1);
    expect(apiError.stdout).toBe('');
    expect(apiError.stderr).toContain('API error 401 (unauthorized):');
    expect(apiError.stderr).not.toContain(ADMIN_TOKEN);
    expect(apiError.stderr).not.toContain(key.secret);
  });

  it('keeps CLI command routes covered by implemented OpenAPI routes', () => {
    const implemented = new Set(IMPLEMENTED_ROUTES.map(routeKey));
    const cliRoutes = new Set(POSTHORN_CLI_ROUTES.map(routeKey));
    const adminCliRoutes = new Set(POSTHORN_ADMIN_CLI_ROUTES.map(routeKey));

    expect(cliRoutes).toEqual(
      new Set([
        'POST /v1/endpoints',
        'POST /v1/messages',
        'GET /v1/endpoints',
        'GET /v1/messages/{id}',
        'GET /v1/usage',
      ]),
    );
    expect(adminCliRoutes).toEqual(
      new Set([
        'POST /v1/admin/apps',
        'GET /v1/admin/apps',
        'GET /v1/admin/apps/{id}',
        'PATCH /v1/admin/apps/{id}',
        'DELETE /v1/admin/apps/{id}',
        'GET /v1/admin/apps/{id}/usage',
        'POST /v1/admin/apps/{id}/rotate-system-secret',
        'POST /v1/admin/apps/{id}/keys',
        'GET /v1/admin/apps/{id}/keys',
        'DELETE /v1/admin/keys/{id}',
      ]),
    );
    for (const route of cliRoutes) {
      expect(implemented.has(route), route).toBe(true);
    }
    for (const route of adminCliRoutes) {
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

async function startAdminGateway(): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  const gateway = createGateway(
    {
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 0,
      adminToken: ADMIN_TOKEN,
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

function adminCliEnv(address: GatewayAddress): Readonly<Record<string, string>> {
  return {
    POSTHORN_URL: address.url,
    POSTHORN_ADMIN_TOKEN: ADMIN_TOKEN,
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
