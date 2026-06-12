import type {
  AdminApiKeyRecord,
  AdminAppRecord,
  CreateAdminApiKeyResult,
  CreateAdminAppResult,
  RotateAdminAppSystemSecretResult,
} from './admin';
import type { DeliveryListPage } from './deliveries';
import type {
  EndpointDeliveriesPage,
  EndpointDeliveryStats,
} from './endpoint-observability';
import type { EndpointTestResult } from './endpoint-tests';
import type { CreateEndpointResult, EndpointRecord, RotateEndpointSecretInput, RotateEndpointSecretResult } from './endpoints';
import type { CreateEventTypeResult, EventTypeRecord } from './event-types';
import type {
  AcceptMessageBatchResult,
  AcceptMessageResult,
  DeliveryStatus,
  JsonValue,
  MessageListPage,
  MessageAttemptsPage,
  MessageStatusResult,
  RetryMessageResult,
} from './messages';
import type { CreatePortalSessionResult } from './portal-sessions';
import { API_ERROR_CODES, type ApiErrorCode, type HttpMethod } from './openapi';
import type { UsageSummary } from './usage';

export interface PosthornClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: ClientFetch;
}

export interface PosthornAdminClientOptions {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly fetch?: ClientFetch;
}

export interface CreateAdminAppInput {
  readonly name: string;
  readonly monthlyMessageQuota?: number | null;
}

export interface UpdateAdminAppInput {
  readonly name?: string;
  readonly monthlyMessageQuota?: number | null;
}

export interface CreateAdminApiKeyInput {
  readonly name?: string | null;
}

export interface RotateAdminAppSystemSecretInput {
  readonly overlapSeconds?: number;
}

export interface CreateEndpointInput {
  readonly url: string;
  readonly eventTypes?: readonly string[] | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface UpdateEndpointInput {
  readonly url?: string;
  readonly eventTypes?: readonly string[] | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
}

export interface SendMessageInput {
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly idempotencyKey?: string;
}

export interface ListMessageAttemptsInput {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListMessagesInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly eventType?: string;
  readonly after?: string;
  readonly before?: string;
}

export interface ListDeliveriesInput {
  readonly status?: DeliveryStatus;
  readonly endpointId?: string;
  readonly eventType?: string;
  readonly failureReason?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListEndpointDeliveriesInput {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface GetEndpointStatsInput {
  readonly days?: number;
}

export type CreateEventTypeInput = (
  | { readonly eventType: string; readonly name?: never }
  | { readonly name: string; readonly eventType?: never }
) & {
  readonly description?: string | null;
  readonly schemaExample?: JsonValue;
};

export interface UpdateEventTypeInput {
  readonly description?: string | null;
  readonly schemaExample?: JsonValue | null;
}

export interface EndpointTestInput {
  readonly eventType?: string;
  readonly payload?: JsonValue;
}

export interface CreatePortalSessionInput {
  readonly endpointId?: string;
  readonly expiresInSeconds?: number;
}

export interface EndpointListResult {
  readonly data: readonly EndpointRecord[];
}

export interface EndpointReadResult {
  readonly endpoint: EndpointRecord;
}

export interface UsageReadResult {
  readonly usage: UsageSummary;
}

export interface AdminAppListResult {
  readonly data: readonly AdminAppRecord[];
}

export interface AdminAppReadResult {
  readonly app: AdminAppRecord;
}

export interface AdminApiKeyListResult {
  readonly data: readonly AdminApiKeyRecord[];
}

export interface EventTypeListResult {
  readonly data: readonly EventTypeRecord[];
}

export interface EventTypeReadResult {
  readonly eventType: EventTypeRecord;
}

export interface EndpointStatsReadResult {
  readonly stats: EndpointDeliveryStats;
}

export interface EndpointTestReadResult {
  readonly test: EndpointTestResult;
}

export interface ClientRouteMapping {
  readonly methodName: string;
  readonly method: HttpMethod;
  readonly path: string;
}

export const POSTHORN_CLIENT_ROUTES: readonly ClientRouteMapping[] = Object.freeze([
  clientRoute('listEndpoints', 'get', '/v1/endpoints'),
  clientRoute('createEndpoint', 'post', '/v1/endpoints'),
  clientRoute('getEndpoint', 'get', '/v1/endpoints/{id}'),
  clientRoute('updateEndpoint', 'patch', '/v1/endpoints/{id}'),
  clientRoute('deleteEndpoint', 'delete', '/v1/endpoints/{id}'),
  clientRoute('rotateEndpointSecret', 'post', '/v1/endpoints/{id}/rotate-secret'),
  clientRoute('testEndpoint', 'post', '/v1/endpoints/{id}/test'),
  clientRoute('listEndpointDeliveries', 'get', '/v1/endpoints/{id}/deliveries'),
  clientRoute('getEndpointStats', 'get', '/v1/endpoints/{id}/stats'),
  clientRoute('listDeliveries', 'get', '/v1/deliveries'),
  clientRoute('listEventTypes', 'get', '/v1/event-types'),
  clientRoute('createEventType', 'post', '/v1/event-types'),
  clientRoute('getEventType', 'get', '/v1/event-types/{id}'),
  clientRoute('updateEventType', 'patch', '/v1/event-types/{id}'),
  clientRoute('deleteEventType', 'delete', '/v1/event-types/{id}'),
  clientRoute('sendMessage', 'post', '/v1/messages'),
  clientRoute('sendMessageBatch', 'post', '/v1/messages/batch'),
  clientRoute('listMessages', 'get', '/v1/messages'),
  clientRoute('getMessage', 'get', '/v1/messages/{id}'),
  clientRoute('retryMessage', 'post', '/v1/messages/{id}/retry'),
  clientRoute('listMessageAttempts', 'get', '/v1/messages/{id}/attempts'),
  clientRoute('getUsage', 'get', '/v1/usage'),
  clientRoute('createPortalSession', 'post', '/v1/portal/sessions'),
]);

export const POSTHORN_ADMIN_CLIENT_ROUTES: readonly ClientRouteMapping[] = Object.freeze([
  clientRoute('listApps', 'get', '/v1/admin/apps'),
  clientRoute('createApp', 'post', '/v1/admin/apps'),
  clientRoute('getApp', 'get', '/v1/admin/apps/{id}'),
  clientRoute('updateApp', 'patch', '/v1/admin/apps/{id}'),
  clientRoute('deleteApp', 'delete', '/v1/admin/apps/{id}'),
  clientRoute('getAppUsage', 'get', '/v1/admin/apps/{id}/usage'),
  clientRoute('rotateAppSystemSecret', 'post', '/v1/admin/apps/{id}/rotate-system-secret'),
  clientRoute('listApiKeys', 'get', '/v1/admin/apps/{id}/keys'),
  clientRoute('createApiKey', 'post', '/v1/admin/apps/{id}/keys'),
  clientRoute('revokeApiKey', 'delete', '/v1/admin/keys/{id}'),
]);

export class PosthornApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly responseBody: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, responseBody: unknown) {
    super(message);
    this.name = 'PosthornApiError';
    this.status = status;
    this.code = code;
    this.responseBody = responseBody;
  }
}

export class PosthornAdminClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: ClientFetch;

  constructor(options: PosthornAdminClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.adminToken = requireNonEmpty(options.adminToken, 'adminToken');
    this.fetchImpl = options.fetch ?? fetch;
  }

  listApps(): Promise<AdminAppListResult> {
    return this.request('get', '/v1/admin/apps');
  }

  createApp(input: CreateAdminAppInput): Promise<CreateAdminAppResult> {
    return this.request('post', '/v1/admin/apps', input);
  }

  getApp(appId: string): Promise<AdminAppReadResult> {
    return this.request('get', `/v1/admin/apps/${pathSegment(appId)}`);
  }

  updateApp(appId: string, input: UpdateAdminAppInput): Promise<AdminAppReadResult> {
    return this.request('patch', `/v1/admin/apps/${pathSegment(appId)}`, input);
  }

  deleteApp(appId: string): Promise<void> {
    return this.request('delete', `/v1/admin/apps/${pathSegment(appId)}`);
  }

  getAppUsage(appId: string): Promise<UsageReadResult> {
    return this.request('get', `/v1/admin/apps/${pathSegment(appId)}/usage`);
  }

  rotateAppSystemSecret(
    appId: string,
    input: RotateAdminAppSystemSecretInput = {},
  ): Promise<RotateAdminAppSystemSecretResult> {
    return this.request('post', `/v1/admin/apps/${pathSegment(appId)}/rotate-system-secret`, input);
  }

  listApiKeys(appId: string): Promise<AdminApiKeyListResult> {
    return this.request('get', `/v1/admin/apps/${pathSegment(appId)}/keys`);
  }

  createApiKey(appId: string, input: CreateAdminApiKeyInput = {}): Promise<CreateAdminApiKeyResult> {
    return this.request('post', `/v1/admin/apps/${pathSegment(appId)}/keys`, input);
  }

  revokeApiKey(keyId: string): Promise<void> {
    return this.request('delete', `/v1/admin/keys/${pathSegment(keyId)}`);
  }

  private request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetchImpl, this.baseUrl, this.adminToken, method, path, body);
  }
}

export class PosthornClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: ClientFetch;

  constructor(options: PosthornClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = requireNonEmpty(options.apiKey, 'apiKey');
    this.fetchImpl = options.fetch ?? fetch;
  }

  listEndpoints(): Promise<EndpointListResult> {
    return this.request('get', '/v1/endpoints');
  }

  createEndpoint(input: CreateEndpointInput): Promise<CreateEndpointResult> {
    return this.request('post', '/v1/endpoints', input);
  }

  getEndpoint(id: string): Promise<EndpointReadResult> {
    return this.request('get', `/v1/endpoints/${pathSegment(id)}`);
  }

  updateEndpoint(id: string, input: UpdateEndpointInput): Promise<EndpointReadResult> {
    return this.request('patch', `/v1/endpoints/${pathSegment(id)}`, input);
  }

  deleteEndpoint(id: string): Promise<void> {
    return this.request('delete', `/v1/endpoints/${pathSegment(id)}`);
  }

  rotateEndpointSecret(id: string, input: RotateEndpointSecretInput = {}): Promise<RotateEndpointSecretResult> {
    return this.request('post', `/v1/endpoints/${pathSegment(id)}/rotate-secret`, input);
  }

  testEndpoint(id: string, input: EndpointTestInput = {}): Promise<EndpointTestReadResult> {
    return this.request('post', `/v1/endpoints/${pathSegment(id)}/test`, input);
  }

  listEndpointDeliveries(id: string, input: ListEndpointDeliveriesInput = {}): Promise<EndpointDeliveriesPage> {
    return this.request('get', `/v1/endpoints/${pathSegment(id)}/deliveries${queryString(input, ['limit', 'cursor'])}`);
  }

  getEndpointStats(id: string, input: GetEndpointStatsInput = {}): Promise<EndpointStatsReadResult> {
    return this.request('get', `/v1/endpoints/${pathSegment(id)}/stats${queryString(input, ['days'])}`);
  }

  listDeliveries(input: ListDeliveriesInput = {}): Promise<DeliveryListPage> {
    return this.request(
      'get',
      `/v1/deliveries${queryString(input, ['status', 'endpointId', 'eventType', 'failureReason', 'limit', 'cursor'])}`,
    );
  }

  listEventTypes(): Promise<EventTypeListResult> {
    return this.request('get', '/v1/event-types');
  }

  createEventType(input: CreateEventTypeInput): Promise<CreateEventTypeResult> {
    const { name, ...rest } = input;
    return this.request('post', '/v1/event-types', { ...rest, eventType: input.eventType ?? name });
  }

  getEventType(id: string): Promise<EventTypeReadResult> {
    return this.request('get', `/v1/event-types/${pathSegment(id)}`);
  }

  updateEventType(id: string, input: UpdateEventTypeInput): Promise<EventTypeReadResult> {
    return this.request('patch', `/v1/event-types/${pathSegment(id)}`, input);
  }

  deleteEventType(id: string): Promise<void> {
    return this.request('delete', `/v1/event-types/${pathSegment(id)}`);
  }

  sendMessage(input: SendMessageInput): Promise<AcceptMessageResult> {
    return this.request('post', '/v1/messages', input);
  }

  sendMessageBatch(items: readonly SendMessageInput[]): Promise<AcceptMessageBatchResult> {
    return this.request('post', '/v1/messages/batch', items);
  }

  listMessages(input: ListMessagesInput = {}): Promise<MessageListPage> {
    return this.request('get', `/v1/messages${queryString(input, ['eventType', 'after', 'before', 'limit', 'cursor'])}`);
  }

  getMessage(id: string): Promise<MessageStatusResult> {
    return this.request('get', `/v1/messages/${pathSegment(id)}`);
  }

  retryMessage(id: string): Promise<RetryMessageResult> {
    return this.request('post', `/v1/messages/${pathSegment(id)}/retry`);
  }

  listMessageAttempts(id: string, input: ListMessageAttemptsInput = {}): Promise<MessageAttemptsPage> {
    return this.request('get', `/v1/messages/${pathSegment(id)}/attempts${queryString(input, ['limit', 'cursor'])}`);
  }

  getUsage(): Promise<UsageReadResult> {
    return this.request('get', '/v1/usage');
  }

  createPortalSession(input: CreatePortalSessionInput = {}): Promise<CreatePortalSessionResult> {
    return this.request('post', '/v1/portal/sessions', input);
  }

  private request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetchImpl, this.baseUrl, this.apiKey, method, path, body);
  }
}

type ClientFetch = (input: string, init: RequestInit) => Promise<Response>;

function clientRoute(methodName: string, method: HttpMethod, path: string): ClientRouteMapping {
  return Object.freeze({ methodName, method, path });
}

function normalizeBaseUrl(value: string): string {
  const trimmed = requireNonEmpty(value, 'baseUrl').replace(/\/+$/, '');
  return new URL(trimmed).toString().replace(/\/+$/, '');
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string.`);
  }

  return value.trim();
}

function pathSegment(value: string): string {
  return encodeURIComponent(requireNonEmpty(value, 'id'));
}

function queryString(input: object, allowedKeys: readonly string[]): string {
  const params = new URLSearchParams();
  const record = input as Record<string, unknown>;
  for (const key of allowedKeys) {
    const value = record[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }

  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function requestJson<T>(
  fetchImpl: ClientFetch,
  baseUrl: string,
  bearerToken: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: {
      authorization: `Bearer ${bearerToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const responseBody = await parseJsonResponse(response);
  if (response.status >= 200 && response.status <= 299) {
    return responseBody as T;
  }

  throw apiErrorFromResponse(response.status, responseBody);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function apiErrorFromResponse(status: number, responseBody: unknown): PosthornApiError {
  const envelope = readErrorEnvelope(responseBody);
  return new PosthornApiError(status, envelope.code, envelope.message, responseBody);
}

function readErrorEnvelope(responseBody: unknown): { readonly code: ApiErrorCode; readonly message: string } {
  if (responseBody !== null && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
    const error = (responseBody as { readonly error?: unknown }).error;
    if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as { readonly code?: unknown }).code;
      const message = (error as { readonly message?: unknown }).message;
      if (typeof code === 'string' && isApiErrorCode(code) && typeof message === 'string') {
        return { code, message };
      }
    }
  }

  return { code: 'internal_error', message: 'Unexpected API error.' };
}

function isApiErrorCode(value: string): value is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value);
}
