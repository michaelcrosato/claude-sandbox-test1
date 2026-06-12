import type { DeliveryListPage } from './deliveries';
import type {
  EndpointDeliveriesPage,
  EndpointDeliveryStats,
  EndpointStatsOptions,
  ListEndpointDeliveriesOptions,
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
}

export interface ListDeliveriesInput {
  readonly status?: DeliveryStatus;
  readonly endpointId?: string;
  readonly eventType?: string;
  readonly failureReason?: string;
  readonly limit?: number;
  readonly cursor?: string;
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

  listEndpointDeliveries(id: string, input: ListEndpointDeliveriesOptions = {}): Promise<EndpointDeliveriesPage> {
    return this.request('get', `/v1/endpoints/${pathSegment(id)}/deliveries${queryString(input)}`);
  }

  getEndpointStats(id: string, input: EndpointStatsOptions = {}): Promise<EndpointStatsReadResult> {
    return this.request('get', `/v1/endpoints/${pathSegment(id)}/stats${queryString(input)}`);
  }

  listDeliveries(input: ListDeliveriesInput = {}): Promise<DeliveryListPage> {
    return this.request('get', `/v1/deliveries${queryString(input)}`);
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
    return this.request('get', `/v1/messages${queryString(input)}`);
  }

  getMessage(id: string): Promise<MessageStatusResult> {
    return this.request('get', `/v1/messages/${pathSegment(id)}`);
  }

  retryMessage(id: string): Promise<RetryMessageResult> {
    return this.request('post', `/v1/messages/${pathSegment(id)}/retry`);
  }

  listMessageAttempts(id: string, input: ListMessageAttemptsInput = {}): Promise<MessageAttemptsPage> {
    return this.request('get', `/v1/messages/${pathSegment(id)}/attempts${queryString(input)}`);
  }

  getUsage(): Promise<UsageReadResult> {
    return this.request('get', '/v1/usage');
  }

  createPortalSession(input: CreatePortalSessionInput = {}): Promise<CreatePortalSessionResult> {
    return this.request('post', '/v1/portal/sessions', input);
  }

  private async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: method.toUpperCase(),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
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

function queryString(input: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }

  return params.size === 0 ? '' : `?${params.toString()}`;
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
