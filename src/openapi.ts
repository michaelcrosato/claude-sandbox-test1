export const API_ERROR_CODES = [
  'invalid_request',
  'invalid_json',
  'url_not_allowed',
  'endpoint_disabled',
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'conflict',
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
  route('get', '/metrics', 'none', 'Prometheus metrics', 200, ['System']),
  route('get', '/v1/endpoints', 'bearer', 'List endpoints', 200, ['Endpoints']),
  route('post', '/v1/endpoints', 'bearer', 'Create endpoint', 201, ['Endpoints']),
  route('get', '/v1/endpoints/{id}', 'bearer', 'Fetch endpoint', 200, ['Endpoints']),
  route('patch', '/v1/endpoints/{id}', 'bearer', 'Update endpoint', 200, ['Endpoints']),
  route('delete', '/v1/endpoints/{id}', 'bearer', 'Delete endpoint', 204, ['Endpoints']),
  route('post', '/v1/endpoints/{id}/rotate-secret', 'bearer', 'Rotate endpoint signing secret', 201, ['Endpoints']),
  route('post', '/v1/endpoints/{id}/test', 'bearer', 'Send endpoint test', 200, ['Endpoints']),
  route('get', '/v1/endpoints/{id}/deliveries', 'bearer', 'List endpoint deliveries', 200, ['Endpoints']),
  route('get', '/v1/endpoints/{id}/stats', 'bearer', 'Read endpoint delivery stats', 200, ['Endpoints']),
  route('get', '/v1/event-types', 'bearer', 'List event types', 200, ['Event Types']),
  route('post', '/v1/event-types', 'bearer', 'Create event type', 201, ['Event Types']),
  route('get', '/v1/event-types/{id}', 'bearer', 'Fetch event type', 200, ['Event Types']),
  route('patch', '/v1/event-types/{id}', 'bearer', 'Update event type', 200, ['Event Types']),
  route('delete', '/v1/event-types/{id}', 'bearer', 'Archive event type', 204, ['Event Types']),
  route('get', '/v1/messages', 'bearer', 'List messages', 200, ['Messages']),
  route('post', '/v1/messages', 'bearer', 'Accept message', 202, ['Messages']),
  route('post', '/v1/messages/batch', 'bearer', 'Accept message batch', 200, ['Messages']),
  route('get', '/v1/messages/{id}', 'bearer', 'Fetch message status', 200, ['Messages']),
  route('post', '/v1/messages/{id}/retry', 'bearer', 'Retry dead-lettered message deliveries', 200, ['Messages']),
  route('get', '/v1/messages/{id}/attempts', 'bearer', 'List message delivery attempts', 200, ['Messages']),
  route('get', '/v1/deliveries', 'bearer', 'List app deliveries', 200, ['Deliveries']),
  route('get', '/v1/usage', 'bearer', 'Read tenant usage', 200, ['Usage']),
  route('post', '/v1/portal/sessions', 'bearer', 'Create portal session', 201, ['Portal']),
  route('get', '/v1/admin/apps', 'admin', 'List apps', 200, ['Admin']),
  route('post', '/v1/admin/apps', 'admin', 'Create app', 201, ['Admin']),
  route('get', '/v1/admin/apps/{id}', 'admin', 'Fetch app', 200, ['Admin']),
  route('patch', '/v1/admin/apps/{id}', 'admin', 'Update app', 200, ['Admin']),
  route('delete', '/v1/admin/apps/{id}', 'admin', 'Delete app', 204, ['Admin']),
  route('get', '/v1/admin/apps/{id}/usage', 'admin', 'Read app usage', 200, ['Admin']),
  route('post', '/v1/admin/apps/{id}/rotate-system-secret', 'admin', 'Rotate app system signing secret', 201, ['Admin']),
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
        DeliveryListItem: objectSchema({
          id: { type: 'string' },
          messageId: { type: 'string' },
          endpointId: { type: 'string' },
          eventType: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'delivering', 'succeeded', 'dead_letter'] },
          attemptCount: { type: 'integer', minimum: 0 },
          nextAttemptAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          lastError: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
        EventType: objectSchema({
          id: { type: 'string' },
          eventType: { type: 'string' },
          description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          schemaExample: {},
          archivedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        }),
        EndpointTest: objectSchema({
          id: { type: 'string' },
          endpointId: { type: 'string' },
          eventType: { type: 'string' },
          payloadSource: { type: 'string', enum: ['explicit', 'schema_example'] },
          outcome: { type: 'string', enum: ['succeeded', 'failed'] },
          responseStatus: { anyOf: [{ type: 'integer', minimum: 100, maximum: 599 }, { type: 'null' }] },
          durationMs: { type: 'integer', minimum: 0 },
          failureReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        }),
        EndpointDeliveryHistory: objectSchema({
          id: { type: 'string' },
          messageId: { type: 'string' },
          endpointId: { type: 'string' },
          eventType: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'delivering', 'succeeded', 'dead_letter'] },
          attemptCount: { type: 'integer', minimum: 0 },
          nextAttemptAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          lastError: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        }),
        EndpointDeliveryStats: objectSchema({
          endpointId: { type: 'string' },
          windowDays: { type: 'integer', minimum: 1, maximum: 90 },
          since: { type: 'string', format: 'date-time' },
          until: { type: 'string', format: 'date-time' },
          total: { type: 'integer', minimum: 0 },
          byStatus: objectSchema({
            pending: { type: 'integer', minimum: 0 },
            delivering: { type: 'integer', minimum: 0 },
            succeeded: { type: 'integer', minimum: 0 },
            dead_letter: { type: 'integer', minimum: 0 },
          }),
          successRate: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
          averageDurationMs: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
          daily: {
            type: 'array',
            items: objectSchema({
              date: { type: 'string' },
              total: { type: 'integer', minimum: 0 },
              succeeded: { type: 'integer', minimum: 0 },
              failed: { type: 'integer', minimum: 0 },
              deadLettered: { type: 'integer', minimum: 0 },
            }),
          },
          failureReasons: {
            type: 'array',
            items: objectSchema({
              reason: { type: 'string' },
              count: { type: 'integer', minimum: 0 },
            }),
          },
        }),
        PortalSession: objectSchema({
          id: { type: 'string' },
          appId: { type: 'string' },
          token: { type: 'string' },
          scope: { type: 'string', enum: ['endpoint_management'] },
          endpointId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          expiresAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          revokedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
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
  const parameters = [...pathParameters(implementedRoute.path), ...queryParameters(implementedRoute)];
  const responses: Record<string, unknown> = {
    [String(implementedRoute.successStatus)]: {
      description: successDescription(implementedRoute.successStatus),
      content:
        implementedRoute.successStatus === 204 ? undefined : successContent(implementedRoute, successSchemaRef(implementedRoute)),
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
    case 'get /metrics':
      return { type: 'string' };
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
    case 'post /v1/endpoints/{id}/rotate-secret':
      return objectSchema({
        endpoint: { $ref: '#/components/schemas/Endpoint' },
        secret: { type: 'string' },
        previousSecretExpiresAt: { type: 'string', format: 'date-time' },
      });
    case 'post /v1/endpoints/{id}/test':
      return objectSchema({ test: { $ref: '#/components/schemas/EndpointTest' } });
    case 'get /v1/endpoints/{id}/deliveries':
      return objectSchema({
        data: { type: 'array', items: { $ref: '#/components/schemas/EndpointDeliveryHistory' } },
        nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      });
    case 'get /v1/endpoints/{id}/stats':
      return objectSchema({ stats: { $ref: '#/components/schemas/EndpointDeliveryStats' } });
    case 'get /v1/event-types':
      return objectSchema({ data: { type: 'array', items: { $ref: '#/components/schemas/EventType' } } });
    case 'post /v1/event-types':
    case 'get /v1/event-types/{id}':
    case 'patch /v1/event-types/{id}':
      return objectSchema({ eventType: { $ref: '#/components/schemas/EventType' } });
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
    case 'get /v1/messages':
      return objectSchema({
        data: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
        nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
    case 'get /v1/deliveries':
      return objectSchema({
        data: { type: 'array', items: { $ref: '#/components/schemas/DeliveryListItem' } },
        nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      });
    case 'get /v1/usage':
    case 'get /v1/admin/apps/{id}/usage':
      return objectSchema({ usage: { $ref: '#/components/schemas/Usage' } });
    case 'post /v1/portal/sessions':
      return objectSchema({ session: { $ref: '#/components/schemas/PortalSession' } });
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
    case 'post /v1/admin/apps/{id}/rotate-system-secret':
      return objectSchema({
        app: { $ref: '#/components/schemas/App' },
        secret: { type: 'string' },
        previousSecretExpiresAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
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
  if (key === 'post /v1/portal/sessions') {
    return {
      required: false,
      content: jsonContent({}),
    };
  }
  if (key === 'post /v1/endpoints/{id}/rotate-secret') {
    return {
      required: false,
      content: jsonContent({
        type: 'object',
        additionalProperties: false,
        properties: {
          overlapSeconds: { type: 'integer', minimum: 60, maximum: 2_592_000 },
        },
      }),
    };
  }
  if (key === 'post /v1/admin/apps/{id}/rotate-system-secret') {
    return {
      required: false,
      content: jsonContent({
        type: 'object',
        additionalProperties: false,
        properties: {
          overlapSeconds: { type: 'integer', minimum: 60, maximum: 2_592_000 },
        },
      }),
    };
  }
  if (
    key === 'post /v1/endpoints' ||
    key === 'patch /v1/endpoints/{id}' ||
    key === 'post /v1/endpoints/{id}/test' ||
    key === 'post /v1/event-types' ||
    key === 'patch /v1/event-types/{id}' ||
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

function queryParameters(implementedRoute: ImplementedRoute): readonly unknown[] {
  const key = `${implementedRoute.method} ${implementedRoute.path}`;
  if (key !== 'get /v1/messages') return [];

  return [
    queryParameter('limit', { type: 'integer', minimum: 1, maximum: 100 }),
    queryParameter('cursor', { type: 'string' }),
    queryParameter('eventType', { type: 'string' }),
    queryParameter('after', { type: 'string', format: 'date-time' }),
    queryParameter('before', { type: 'string', format: 'date-time' }),
  ];
}

function queryParameter(name: string, schema: OpenApiSchema): Record<string, unknown> {
  return {
    name,
    in: 'query',
    required: false,
    schema,
  };
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

function successContent(implementedRoute: ImplementedRoute, schema: OpenApiSchema): Record<string, unknown> {
  if (`${implementedRoute.method} ${implementedRoute.path}` === 'get /metrics') {
    return {
      'text/plain; version=0.0.4': {
        schema,
      },
    };
  }

  return jsonContent(schema);
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
