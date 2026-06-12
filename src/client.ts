import type { CreateEndpointResult, EndpointRecord } from './endpoints';
import type {
  AcceptMessageBatchResult,
  AcceptMessageResult,
  JsonValue,
  MessageAttemptsPage,
  MessageStatusResult,
  RetryMessageResult,
} from './messages';
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

export interface EndpointListResult {
  readonly data: readonly EndpointRecord[];
}

export interface EndpointReadResult {
  readonly endpoint: EndpointRecord;
}

export interface UsageReadResult {
  readonly usage: UsageSummary;
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
  clientRoute('sendMessage', 'post', '/v1/messages'),
  clientRoute('sendMessageBatch', 'post', '/v1/messages/batch'),
  clientRoute('getMessage', 'get', '/v1/messages/{id}'),
  clientRoute('retryMessage', 'post', '/v1/messages/{id}/retry'),
  clientRoute('listMessageAttempts', 'get', '/v1/messages/{id}/attempts'),
  clientRoute('getUsage', 'get', '/v1/usage'),
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

  sendMessage(input: SendMessageInput): Promise<AcceptMessageResult> {
    return this.request('post', '/v1/messages', input);
  }

  sendMessageBatch(items: readonly SendMessageInput[]): Promise<AcceptMessageBatchResult> {
    return this.request('post', '/v1/messages/batch', items);
  }

  getMessage(id: string): Promise<MessageStatusResult> {
    return this.request('get', `/v1/messages/${pathSegment(id)}`);
  }

  retryMessage(id: string): Promise<RetryMessageResult> {
    return this.request('post', `/v1/messages/${pathSegment(id)}/retry`);
  }

  listMessageAttempts(id: string, input: ListMessageAttemptsInput = {}): Promise<MessageAttemptsPage> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.cursor !== undefined) params.set('cursor', input.cursor);
    const query = params.size === 0 ? '' : `?${params.toString()}`;
    return this.request('get', `/v1/messages/${pathSegment(id)}/attempts${query}`);
  }

  getUsage(): Promise<UsageReadResult> {
    return this.request('get', '/v1/usage');
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
