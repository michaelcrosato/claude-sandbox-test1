import { randomBytes } from 'node:crypto';

import { getEndpointDeliveryTarget } from './endpoints';
import { getActiveEventTypeByName, parseEventType } from './event-types';
import { revealEndpointSecret, SecretProtectionError } from './secret-protection';
import type { PosthornStorage } from './storage';
import { isJsonValue, type JsonValue } from './validation';
import type { DeliveryFetch, DeliveryFailureReason } from './worker';
import { signWebhook } from './webhooks';

export type EndpointTestPayloadSource = 'explicit' | 'schema_example';
export type EndpointTestOutcome = 'succeeded' | 'failed';
export type EndpointTestErrorCode = 'invalid_request' | 'endpoint_disabled';

export interface EndpointTestOptions {
  readonly fetch?: DeliveryFetch;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface EndpointTestResult {
  readonly id: string;
  readonly endpointId: string;
  readonly eventType: string;
  readonly payloadSource: EndpointTestPayloadSource;
  readonly outcome: EndpointTestOutcome;
  readonly responseStatus: number | null;
  readonly durationMs: number;
  readonly failureReason: DeliveryFailureReason | null;
}

export class EndpointTestError extends Error {
  readonly code: EndpointTestErrorCode;

  constructor(code: EndpointTestErrorCode, message: string) {
    super(message);
    this.name = 'EndpointTestError';
    this.code = code;
  }
}

const TEST_DELIVERY_ID_PREFIX = 'test_';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'posthorn-endpoint-test';
const MANAGED_HEADER_NAMES = new Set([
  'content-length',
  'content-type',
  'host',
  'user-agent',
  'webhook-id',
  'webhook-signature',
  'webhook-timestamp',
]);

export async function sendEndpointTest(
  storage: PosthornStorage,
  appId: string,
  endpointId: string,
  input: unknown,
  options: EndpointTestOptions = {},
): Promise<EndpointTestResult | null> {
  const endpoint = getEndpointDeliveryTarget(storage, appId, endpointId);
  if (endpoint === null) return null;
  if (!endpoint.enabled) {
    throw new EndpointTestError('endpoint_disabled', 'Endpoint is disabled.');
  }

  const body = requireObject(input);
  const eventType = parseEventType(body.eventType);
  const payload = resolvePayload(storage, appId, eventType, body);
  const id = generateTestDeliveryId();
  const attemptedAt = options.now?.() ?? new Date();
  const rawBody = JSON.stringify({ id, eventType, payload: payload.value });
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;
  const abortController = new AbortController();

  try {
    const secret = revealEndpointSecret(storage, {
      ciphertext: endpoint.signingSecretCiphertext,
      keyVersion: endpoint.signingSecretKeyVersion,
      nonce: endpoint.signingSecretNonce,
    });
    const signedHeaders = signWebhook(secret, rawBody, {
      id,
      timestampSeconds: Math.floor(attemptedAt.getTime() / 1000),
    });
    const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));

    timeout = setTimeout(() => {
      abortController.abort();
    }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: buildDeliveryHeaders(endpoint.headers, signedHeaders),
      body: rawBody,
      redirect: 'manual',
      signal: abortController.signal,
    });
    await response.body?.cancel().catch(() => undefined);

    const durationMs = elapsedMs(startedAt);
    if (response.status >= 200 && response.status <= 299) {
      return {
        id,
        endpointId,
        eventType,
        payloadSource: payload.source,
        outcome: 'succeeded',
        responseStatus: response.status,
        durationMs,
        failureReason: null,
      };
    }

    return {
      id,
      endpointId,
      eventType,
      payloadSource: payload.source,
      outcome: 'failed',
      responseStatus: response.status,
      durationMs,
      failureReason: `http_${response.status}`,
    };
  } catch (error) {
    return {
      id,
      endpointId,
      eventType,
      payloadSource: payload.source,
      outcome: 'failed',
      responseStatus: null,
      durationMs: elapsedMs(startedAt),
      failureReason: classifyFailureReason(error),
    };
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function resolvePayload(
  storage: PosthornStorage,
  appId: string,
  eventType: string,
  body: Record<string, unknown>,
): { readonly source: EndpointTestPayloadSource; readonly value: JsonValue } {
  if (Object.hasOwn(body, 'payload')) {
    if (body.payload === null || !isJsonValue(body.payload)) {
      throw new EndpointTestError('invalid_request', 'payload must be a non-null JSON value.');
    }

    return { source: 'explicit', value: body.payload };
  }

  const catalogEntry = getActiveEventTypeByName(storage, appId, eventType);
  if (catalogEntry?.schemaExample === null || catalogEntry?.schemaExample === undefined) {
    throw new EndpointTestError('invalid_request', 'payload is required when the event type has no schemaExample.');
  }

  return { source: 'schema_example', value: catalogEntry.schemaExample };
}

function requireObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EndpointTestError('invalid_request', 'Expected a JSON object.');
  }

  return input as Record<string, unknown>;
}

function buildDeliveryHeaders(
  endpointHeaders: Readonly<Record<string, string>>,
  signedHeaders: Readonly<Record<string, string | number | readonly string[] | null | undefined>>,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(endpointHeaders)) {
    if (!MANAGED_HEADER_NAMES.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  headers['content-type'] = 'application/json; charset=utf-8';
  headers['user-agent'] = USER_AGENT;
  for (const [name, value] of Object.entries(signedHeaders)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }

  return headers;
}

function classifyFailureReason(error: unknown): DeliveryFailureReason {
  if (error instanceof SecretProtectionError) return 'signing_secret_unavailable';
  if (isAbortError(error)) return 'timeout';
  return 'network_error';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('operation was aborted'))
  );
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function generateTestDeliveryId(): string {
  return `${TEST_DELIVERY_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}
