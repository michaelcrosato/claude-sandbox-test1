export const API_ERROR_CODES = [
  'invalid_request',
  'invalid_json',
  'url_not_allowed',
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'idempotency_conflict',
  'payload_too_large',
  'quota_exceeded',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

export interface ImplementedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: 'none' | 'bearer' | 'admin';
  readonly summary: string;
  readonly successStatus: number;
  readonly tags: readonly string[];
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly paths: Record<string, Record<HttpMethod, OpenApiOperation>>;
  readonly components: {
    readonly securitySchemes: {
      readonly bearerAuth: {
        readonly type: 'http';
        readonly scheme: 'bearer';
      };
    };
    readonly schemas: Record<string, OpenApiSchema>;
  };
}

interface OpenApiOperation {
  readonly tags: readonly string[];
  readonly summary: string;
  readonly operationId: string;
  readonly security?: ReadonlyArray<Record<string, readonly string[]>>;
  readonly requestBody?: unknown;
  readonly parameters?: readonly unknown[];
  readonly responses: Record<string, unknown>;
}

type OpenApiSchema = Record<string, unknown>;

export const IMPLEMENTED_ROUTES: readonly ImplementedRoute[] = Object.freeze([
  route('get', '/healthz', 'none', 'Health check', 200, ['System']),
  route('get', '/readyz', 'none', 'Readiness check', 200, ['System']),
  route('get', '/openapi.json', 'none', 'OpenAPI contract', 200, ['System']),
  route('get', '/v1/endpoints', 'bearer', 'List endpoints', 200, ['Endpoints']),
  route('post', '/v1/endpoints', 'bearer', 'Create endpoint', 201, ['Endpoints']),
  route('get', '/v1/endpoints/{id}', 'bearer', 'Fetch endpoint', 200, ['Endpoints']),
  route('patch', '/v1/endpoints/{id}', 'bearer', 'Update endpoint', 200, ['Endpoints']),
  route('delete', '/v1/endpoints/{id}', 'bearer', 'Delete endpoint', 204, ['Endpoints']),
  route('post', '/v1/messages', 'bearer', 'Accept message', 202, ['Messages']),
  route('post', '/v1/messages/batch', 'bearer', 'Accept message batch', 200, ['Messages']),
  route('get', '/v1/messages/{id}', 'bearer', 'Fetch message status', 200, ['Messages']),
  route('post', '/v1/messages/{id}/retry', 'bearer', 'Retry dead-lettered message deliveries', 200, ['Messages']),
  route('get', '/v1/messages/{id}/attempts', 'bearer', 'List message delivery attempts', 200, ['Messages']),
  route('get', '/v1/usage', 'bearer', 'Read tenant usage', 200, ['Usage']),
  route('get', '/v1/admin/apps', 'admin', 'List apps', 200, ['Admin']),
  route('post', '/v1/admin/apps', 'admin', 'Create app', 201, ['Admin']),
  route('get', '/v1/admin/apps/{id}', 'admin', 'Fetch app', 200, ['Admin']),
  route('patch', '/v1/admin/apps/{id}', 'admin', 'Update app', 200, ['Admin']),
  route('delete', '/v1/admin/apps/{id}', 'admin', 'Delete app', 204, ['Admin']),
  route('get', '/v1/admin/apps/{id}/usage', 'admin', 'Read app usage', 200, ['Admin']),
  route('get', '/v1/admin/apps/{id}/keys', 'admin', 'List app API keys', 200, ['Admin']),
  route('post', '/v1/admin/apps/{id}/keys', 'admin', 'Create app API key', 201, ['Admin']),
  route('delete', '/v1/admin/keys/{id}', 'admin', 'Revoke API key', 204, ['Admin']),
]);

export function createOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<HttpMethod, OpenApiOperation>> = {};
  for (const implementedRoute of IMPLEMENTED_ROUTES) {
    paths[implementedRoute.path] ??= {} as Record<HttpMethod, OpenApiOperation>;
    paths[implementedRoute.path][implementedRoute.method] = operationForRoute(implementedRoute);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Posthorn API',
      version: '0.0.0',
      description: 'Reliable webhook delivery for SaaS teams.',
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
      schemas: {
        Error: errorSchema(),
        ErrorEnvelope: errorEnvelopeSchema(),
        Health: objectSchema({
          status: { type: 'string', enum: ['ok'] },
          service: { type: 'string' },
        }),
        Readiness: objectSchema({
          status: { type: 'string', enum: ['ok'] },
          service: { type: 'string' },
        }),
        Message: objectSchema({
          id: { type: 'string' },
          eventType: { type: 'string' },
          payload: {},
          createdAt: { type: 'string', format: 'date-time' },
        }),
        Delivery: objectSchema({
          id: { type: 'string' },
          messageId: { type: 'string' },
          endpointId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'delivering', 'succeeded', 'dead_letter'] },
          attemptCount: { type: 'integer', minimum: 0 },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        }),
        Fanout: objectSchema({
          matched: { type: 'integer', minimum: 0 },
          deliveryIds: { type: 'array', items: { type: 'string' } },
          endpointIds: { type: 'array', items: { type: 'string' } },
        }),
        Endpoint: objectSchema({
          id: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          eventTypes: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          enabled: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        }),
        App: objectSchema({
          id: { type: 'string' },
          name: { type: 'string' },
          monthlyMessageQuota: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
          createdAt: { type: 'string', format: 'date-time' },
        }),
        ApiKey: objectSchema({
          id: { type: 'string' },
          appId: { type: 'string' },
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          revokedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          createdAt: { type: 'string', format: 'date-time' },
        }),
        Usage: objectSchema({
          appId: { type: 'string' },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          messagesAccepted: { type: 'integer', minimum: 0 },
          deliveryAttempts: { type: 'integer', minimum: 0 },
          quota: objectSchema({
            monthlyMessageQuota: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
            remaining: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
            exceeded: { type: 'boolean' },
          }),
        }),
      },
    },
  };
}

function route(
  method: HttpMethod,
  path: string,
  auth: ImplementedRoute['auth'],
  summary: string,
  successStatus: number,
  tags: readonly string[],
): ImplementedRoute {
  return Object.freeze({ method, path, auth, summary, successStatus, tags });
}

function operationForRoute(implementedRoute: ImplementedRoute): OpenApiOperation {
  const requestBody = requestBodyForRoute(implementedRoute);
  const parameters = pathParameters(implementedRoute.path);
  const responses: Record<string, unknown> = {
    [String(implementedRoute.successStatus)]: {
      description: successDescription(implementedRoute.successStatus),
      content: implementedRoute.successStatus === 204 ? undefined : jsonContent(successSchemaRef(implementedRoute)),
    },
    default: {
      description: 'Error response',
      content: jsonContent({ $ref: '#/components/schemas/ErrorEnvelope' }),
    },
  };
  if (implementedRoute.successStatus === 204) {
    delete (responses['204'] as { content?: unknown }).content;
  }

  return {
    tags: implementedRoute.tags,
    summary: implementedRoute.summary,
    operationId: operationId(implementedRoute),
    ...(implementedRoute.auth === 'none' ? {} : { security: [{ bearerAuth: [] }] }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(requestBody === null ? {} : { requestBody }),
    responses,
  };
}

function successDescription(status: number): string {
  if (status === 204) return 'No content.';
  if (status === 201) return 'Created.';
  if (status === 202) return 'Accepted.';
  return 'OK.';
}

function successSchemaRef(implementedRoute: ImplementedRoute): OpenApiSchema {
  const key = `${implementedRoute.method} ${implementedRoute.path}`;
  switch (key) {
    case 'get /healthz':
      return { $ref: '#/components/schemas/Health' };
    case 'get /readyz':
      return { $ref: '#/components/schemas/Readiness' };
    case 'get /openapi.json':
      return { type: 'object' };
    case 'get /v1/endpoints':
      return objectSchema({ data: { type: 'array', items: { $ref: '#/components/schemas/Endpoint' } } });
    case 'post /v1/endpoints':
      return objectSchema({
        endpoint: { $ref: '#/components/schemas/Endpoint' },
        secret: { type: 'string' },
      });
    case 'get /v1/endpoints/{id}':
    case 'patch /v1/endpoints/{id}':
      return objectSchema({ endpoint: { $ref: '#/components/schemas/Endpoint' } });
    case 'post /v1/messages':
      return acceptedMessageSchema();
    case 'post /v1/messages/batch':
      return objectSchema({
        results: {
          type: 'array',
          items: {
            oneOf: [
              {
                allOf: [
                  objectSchema({ ok: { type: 'boolean', const: true } }),
                  acceptedMessageSchema(),
                ],
              },
              objectSchema({
                ok: { type: 'boolean', const: false },
                error: { $ref: '#/components/schemas/Error' },
              }),
            ],
          },
        },
      });
    case 'get /v1/messages/{id}':
      return objectSchema({
        message: { $ref: '#/components/schemas/Message' },
        deliveries: { type: 'array', items: { $ref: '#/components/schemas/Delivery' } },
      });
    case 'post /v1/messages/{id}/retry':
      return objectSchema({ retried: { type: 'integer', minimum: 0 } });
    case 'get /v1/messages/{id}/attempts':
      return objectSchema({
        data: { type: 'array', items: { type: 'object' } },
        nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      });
    case 'get /v1/usage':
    case 'get /v1/admin/apps/{id}/usage':
      return objectSchema({ usage: { $ref: '#/components/schemas/Usage' } });
    case 'get /v1/admin/apps':
      return objectSchema({ data: { type: 'array', items: { $ref: '#/components/schemas/App' } } });
    case 'post /v1/admin/apps':
    case 'get /v1/admin/apps/{id}':
    case 'patch /v1/admin/apps/{id}':
      return objectSchema({ app: { $ref: '#/components/schemas/App' } });
    case 'get /v1/admin/apps/{id}/keys':
      return objectSchema({ data: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } } });
    case 'post /v1/admin/apps/{id}/keys':
      return objectSchema({
        apiKey: { $ref: '#/components/schemas/ApiKey' },
        secret: { type: 'string' },
      });
    default:
      return {};
  }
}

function acceptedMessageSchema(): OpenApiSchema {
  return objectSchema({
    message: { $ref: '#/components/schemas/Message' },
    fanout: { $ref: '#/components/schemas/Fanout' },
  });
}

function requestBodyForRoute(implementedRoute: ImplementedRoute): unknown | null {
  const key = `${implementedRoute.method} ${implementedRoute.path}`;
  if (
    key === 'post /v1/endpoints' ||
    key === 'patch /v1/endpoints/{id}' ||
    key === 'post /v1/messages' ||
    key === 'post /v1/messages/batch' ||
    key === 'post /v1/admin/apps' ||
    key === 'patch /v1/admin/apps/{id}' ||
    key === 'post /v1/admin/apps/{id}/keys'
  ) {
    return {
      required: key !== 'post /v1/admin/apps/{id}/keys',
      content: jsonContent(key === 'post /v1/messages/batch' ? { type: 'array', minItems: 1, maxItems: 100 } : {}),
    };
  }

  return null;
}

function pathParameters(path: string): readonly unknown[] {
  const matches = path.matchAll(/\{([^}]+)\}/g);
  return Array.from(matches, (match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function operationId(implementedRoute: ImplementedRoute): string {
  const pathName = implementedRoute.path
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, 'by-$1')
    .replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) => (next === undefined ? '' : next.toUpperCase()));
  return `${implementedRoute.method}${pathName.charAt(0).toUpperCase()}${pathName.slice(1)}`;
}

function jsonContent(schema: OpenApiSchema): Record<string, unknown> {
  return {
    'application/json': {
      schema,
    },
  };
}

function errorEnvelopeSchema(): OpenApiSchema {
  return objectSchema({
    error: { $ref: '#/components/schemas/Error' },
  });
}

function errorSchema(): OpenApiSchema {
  return objectSchema({
    code: { type: 'string', enum: [...API_ERROR_CODES] },
    message: { type: 'string' },
  });
}

function objectSchema(properties: Record<string, unknown>): OpenApiSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
