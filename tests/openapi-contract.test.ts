import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  createGateway,
  createOpenApiDocument,
  hashApiKey,
  IMPLEMENTED_ROUTES,
  loadConfig,
  openStorage,
  type Gateway,
  type GatewayAddress,
  type HttpMethod,
  type PosthornStorage,
} from '../src/index';

const TENANT_KEY = `phk_${Buffer.alloc(32, 41).toString('base64url')}`;

const activeGateways: Gateway[] = [];

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

describe('OpenAPI contract', () => {
  it('serves a dependency-free OpenAPI 3.1 document for implemented routes', async () => {
    const { address } = await startSeededGateway();

    const response = await fetch(`${address.url}/openapi.json`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(createOpenApiDocument());
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('Posthorn API');
    expectValidOpenApi31(body);
    expect(body.components.schemas.Error.properties.code.enum).toEqual([...API_ERROR_CODES]);
    expect(operationSet(body)).toEqual(operationSet(createOpenApiDocument()));
    expect(operationSet(body)).toEqual(new Set(IMPLEMENTED_ROUTES.map(routeKey)));
    expect(JSON.stringify(body)).not.toContain('phk_');
    expect(JSON.stringify(body)).not.toContain('whsec_');
    expect(JSON.stringify(body)).not.toContain('sha256:');
  });

  it('keeps README implemented route rows synchronized with OpenAPI operations', () => {
    const readme = readFileSync('README.md', 'utf8');
    const readmeRoutes = readmeImplementedRouteSet(readme);

    expect(readmeRoutes).toEqual(operationSet(createOpenApiDocument()));
  });

  it('keeps README implemented error codes synchronized with the OpenAPI enum', () => {
    const readme = readFileSync('README.md', 'utf8');
    const schemaCodes = openApiErrorCodes(createOpenApiDocument());

    expect(readmeImplementedErrorCodes(readme)).toEqual(schemaCodes);
  });

  it('matches runtime error codes to the closed OpenAPI Error.code enum', async () => {
    const { address } = await startSeededGateway({ monthlyMessageQuota: 1 });
    const emitted = new Set<string>();

    await collectErrorCode(emitted, await fetch(`${address.url}/does-not-exist`));
    await collectErrorCode(emitted, await fetch(`${address.url}/openapi.json`, { method: 'POST' }));
    await collectErrorCode(emitted, await fetch(`${address.url}/v1/endpoints`));
    await collectErrorCode(
      emitted,
      await fetch(`${address.url}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TENANT_KEY}`,
          'content-type': 'application/json',
        },
        body: '{',
      }),
    );
    await collectErrorCode(
      emitted,
      await requestJson(address, 'POST', '/v1/messages', TENANT_KEY, { payload: {} }),
    );
    await collectErrorCode(
      emitted,
      await requestJson(address, 'POST', '/v1/endpoints', TENANT_KEY, {
        url: 'http://127.0.0.1/webhook',
      }),
    );
    const eventType = await requestJson(address, 'POST', '/v1/event-types', TENANT_KEY, {
      eventType: 'contract.created',
      schemaExample: { id: 1 },
    });
    expect(eventType.status).toBe(201);
    await collectErrorCode(
      emitted,
      await requestJson(address, 'POST', '/v1/event-types', TENANT_KEY, {
        eventType: 'contract.created',
        schemaExample: { id: 2 },
      }),
    );
    const endpoint = await requestJson(address, 'POST', '/v1/endpoints', TENANT_KEY, {
      url: 'https://example.com/disabled-test',
    });
    expect(endpoint.status).toBe(201);
    const endpointBody = (await endpoint.json()) as { readonly endpoint: { readonly id: string } };
    const disabled = await requestJson(address, 'PATCH', `/v1/endpoints/${endpointBody.endpoint.id}`, TENANT_KEY, {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    await collectErrorCode(
      emitted,
      await requestJson(address, 'POST', `/v1/endpoints/${endpointBody.endpoint.id}/test`, TENANT_KEY, {
        eventType: 'contract.created',
        payload: { id: 1 },
      }),
    );

    const first = await requestJson(address, 'POST', '/v1/messages', TENANT_KEY, {
      eventType: 'contract.conflict',
      payload: { id: 1 },
      idempotencyKey: 'contract-conflict',
    });
    expect(first.status).toBe(202);
    await collectErrorCode(
      emitted,
      await requestJson(address, 'POST', '/v1/messages', TENANT_KEY, {
        eventType: 'contract.conflict',
        payload: { id: 2 },
        idempotencyKey: 'contract-conflict',
      }),
    );
    await collectErrorCode(
      emitted,
      await requestJson(address, 'POST', '/v1/messages', TENANT_KEY, {
        eventType: 'contract.quota',
        payload: { id: 3 },
      }),
    );

    const payloadLimitGateway = await startSeededGateway({ maxBodyBytes: 8 });
    await collectErrorCode(
      emitted,
      await requestJson(payloadLimitGateway.address, 'POST', '/v1/endpoints', TENANT_KEY, {
        url: 'https://example.com/webhook',
      }),
    );

    const readinessGateway = await startSeededGateway({
      readinessProbe: () => {
        throw new Error('synthetic readiness failure');
      },
    });
    await collectErrorCode(emitted, await fetch(`${readinessGateway.address.url}/readyz`));

    expect(emitted).toEqual(openApiErrorCodes(createOpenApiDocument()));
  });
});

async function startSeededGateway(
  options: {
    readonly maxBodyBytes?: number;
    readonly monthlyMessageQuota?: number | null;
    readonly readinessProbe?: (storage: PosthornStorage) => void;
  } = {},
): Promise<{ address: GatewayAddress; storage: PosthornStorage }> {
  const storage = openStorage({ dataDir: ':memory:' });
  seedTenant(storage, 'app_contract', 'Contract Tenant', TENANT_KEY, options.monthlyMessageQuota ?? null);
  const gateway = createGateway(
    {
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 0,
      maxBodyBytes: options.maxBodyBytes,
    },
    {
      openStorage: () => storage,
      readinessProbe: options.readinessProbe,
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
      'Contract key',
      null,
      '2026-06-12T00:00:00.000Z',
    );
}

async function collectErrorCode(emitted: Set<string>, response: Response): Promise<void> {
  expect(response.status).toBeGreaterThanOrEqual(400);
  const body = (await response.json()) as ErrorJson;
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  emitted.add(body.error.code);
}

function requestJson(
  address: GatewayAddress,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${address.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function operationSet(document: ReturnType<typeof createOpenApiDocument>): Set<string> {
  const operations = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of Object.keys(pathItem) as HttpMethod[]) {
      operations.add(`${method.toUpperCase()} ${path}`);
    }
  }

  return operations;
}

function openApiErrorCodes(document: ReturnType<typeof createOpenApiDocument>): Set<string> {
  const schema = document.components.schemas.Error as {
    readonly properties?: { readonly code?: { readonly enum?: readonly string[] } };
  };
  return new Set(schema.properties?.code?.enum ?? []);
}

function expectValidOpenApi31(document: ReturnType<typeof createOpenApiDocument>): void {
  expectNoUndefined(document);
  expect(document.openapi).toBe('3.1.0');
  expect(document.info.title).toBeTruthy();
  expect(document.info.version).toBeTruthy();
  expect(document.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  expect(document.components.schemas.ErrorEnvelope).toBeDefined();

  const operationIds = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    expect(path).toMatch(/^\//);
    expect(Object.keys(pathItem).length).toBeGreaterThan(0);

    for (const method of Object.keys(pathItem) as HttpMethod[]) {
      expect(['get', 'post', 'patch', 'delete']).toContain(method);
      const operation = pathItem[method];
      const route = IMPLEMENTED_ROUTES.find((candidate) => candidate.method === method && candidate.path === path);
      expect(route).toBeDefined();
      if (route === undefined) continue;

      expect(operation.operationId).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(operationIds.has(operation.operationId)).toBe(false);
      operationIds.add(operation.operationId);
      expect(operation.summary).toBeTruthy();
      expect(operation.tags.length).toBeGreaterThan(0);
      expect(operation.responses[String(route.successStatus)]).toBeDefined();
      expect(operation.responses.default).toBeDefined();
      expect(successResponseContent(operation.responses[String(route.successStatus)])).toBe(route.successStatus !== 204);
      expect(defaultErrorRef(operation.responses.default)).toBe('#/components/schemas/ErrorEnvelope');
      expect(parameterNames(operation.parameters)).toEqual(pathParameterNames(path));
      if (method === 'get' && path === '/v1/messages') {
        expect(queryParameterNames(operation.parameters)).toEqual(['limit', 'cursor', 'eventType', 'after', 'before']);
      }
      if (route.auth === 'none') {
        expect(operation.security).toBeUndefined();
      } else {
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
      }
    }
  }

  for (const ref of collectRefs(document)) {
    expect(ref.startsWith('#/components/schemas/')).toBe(true);
    expect(document.components.schemas[ref.replace('#/components/schemas/', '')]).toBeDefined();
  }
}

function expectNoUndefined(value: unknown, path: string = 'document'): void {
  expect(value, path).not.toBeUndefined();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      expectNoUndefined(item, `${path}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      expectNoUndefined(child, `${path}.${key}`);
    }
  }
}

function successResponseContent(response: unknown): boolean {
  return Boolean((response as { readonly content?: unknown } | undefined)?.content);
}

function defaultErrorRef(response: unknown): string | undefined {
  return (response as { readonly content?: { readonly 'application/json'?: { readonly schema?: { readonly $ref?: string } } } })
    .content?.['application/json']?.schema?.$ref;
}

function parameterNames(parameters: unknown): readonly string[] {
  return ((parameters ?? []) as readonly { readonly name: string; readonly in: string }[])
    .filter((parameter) => parameter.in === 'path')
    .map((parameter) => parameter.name);
}

function queryParameterNames(parameters: unknown): readonly string[] {
  return ((parameters ?? []) as readonly { readonly name: string; readonly in: string }[])
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name);
}

function pathParameterNames(path: string): readonly string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1]);
}

function collectRefs(value: unknown): readonly string[] {
  const refs: string[] = [];
  collectRefsInto(value, refs);
  return refs;
}

function collectRefsInto(value: unknown, refs: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefsInto(item, refs);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string') refs.push(record.$ref);
    for (const child of Object.values(record)) {
      collectRefsInto(child, refs);
    }
  }
}

function routeKey(route: (typeof IMPLEMENTED_ROUTES)[number]): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

function readmeImplementedRouteSet(readme: string): Set<string> {
  const rows = markdownRows(readme, '## API Routes');
  const operations = new Set<string>();
  for (const row of rows) {
    const [methods, rawPath, _auth, status] = row;
    if (status !== 'implemented') continue;
    const path = normalizeReadmePath(rawPath);
    for (const method of methods.split('/')) {
      operations.add(`${method.trim().toUpperCase()} ${path}`);
    }
  }

  return operations;
}

function readmeImplementedErrorCodes(readme: string): Set<string> {
  const rows = markdownRows(readme, '### Error responses');
  return new Set(
    rows
      .filter((row) => row[2] === 'implemented')
      .map((row) => row[0].replace(/`/g, '').trim()),
  );
}

function markdownRows(markdown: string, heading: string): readonly string[][] {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`Missing heading: ${heading}`);
  const lines = markdown.slice(start).split(/\r?\n/);
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    if (/^\|\s*-+/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells[0] === 'Method' || cells[0] === '`code`') continue;
    rows.push(cells);
  }

  return rows;
}

function normalizeReadmePath(rawPath: string): string {
  return rawPath
    .replace(/`/g, '')
    .trim()
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
