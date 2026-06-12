import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AdminValidationError,
  createAdminApiKey,
  createAdminApp,
  deleteAdminApp,
  getAdminApp,
  listAdminApiKeys,
  listAdminApps,
  revokeAdminApiKey,
  updateAdminApp,
} from './admin';
import { authenticateAdminToken, authenticateApiKey, type AuthenticatedTenant } from './auth';
import type { PosthornConfig } from './config';
import {
  archiveEventType,
  createEventType,
  EventTypeConflictError,
  EventTypeValidationError,
  getEventType,
  listEventTypes,
  updateEventType,
} from './event-types';
import {
  createEndpoint,
  deleteEndpoint,
  EndpointValidationError,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
} from './endpoints';
import { EndpointTestError, sendEndpointTest } from './endpoint-tests';
import {
  acceptMessage,
  acceptMessageBatch,
  getMessageStatus,
  listMessages,
  listMessageAttempts,
  MessageConflictError,
  MessageValidationError,
  retryMessage,
} from './messages';
import { renderAdminDashboardPage, renderTenantDashboardPage } from './dashboard';
import { renderPrometheusMetrics } from './metrics';
import { createOpenApiDocument } from './openapi';
import { createPortalSession, PortalSessionValidationError } from './portal-sessions';
import { openStorage, type PosthornStorage } from './storage';
import { getUsageSummary, UsageQuotaExceededError } from './usage';
import type { DeliveryFetch } from './worker';

export interface GatewayConfig extends Partial<PosthornConfig> {
  readonly serviceName?: string;
}

export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface GatewayDependencies {
  readonly openStorage?: (options: { readonly dataDir: string }) => PosthornStorage;
  readonly readinessProbe?: (storage: PosthornStorage) => void;
  readonly deliveryFetch?: DeliveryFetch;
  readonly now?: () => Date;
}

export interface Gateway {
  readonly serviceName: string;
  readonly config: Readonly<GatewayConfig>;
  start(): Promise<GatewayAddress>;
  stop(): Promise<void>;
}

export function createGateway(config: GatewayConfig = {}, dependencies: GatewayDependencies = {}): Gateway {
  const normalizedConfig: GatewayConfig = Object.freeze({
    ...config,
    serviceName: config.serviceName ?? 'posthorn',
  });
  let server: Server | null = null;
  let storage: PosthornStorage | null = null;
  let address: GatewayAddress | null = null;
  let startPromise: Promise<GatewayAddress> | null = null;
  let readinessError: Error | null = null;

  const storageFactory = dependencies.openStorage ?? openStorage;
  const now = dependencies.now ?? (() => new Date());
  const deliveryFetch = dependencies.deliveryFetch ?? ((url, init) => fetch(url, init));
  const startedAt = now();
  const readinessProbe =
    dependencies.readinessProbe ??
    ((currentStorage: PosthornStorage) => {
      currentStorage.db.prepare('SELECT 1').get();
    });

  return Object.freeze({
    serviceName: normalizedConfig.serviceName ?? 'posthorn',
    config: normalizedConfig,
    async start() {
      if (address !== null) return address;
      if (startPromise !== null) return startPromise;

      startPromise = startGateway();
      try {
        return await startPromise;
      } finally {
        startPromise = null;
      }
    },
    async stop() {
      try {
        if (startPromise !== null) {
          await startPromise;
        }
      } catch {
        // Failed starts clean up their own partial resources; stop remains safe.
      }
      const activeServer = server;
      const activeStorage = storage;
      server = null;
      storage = null;
      address = null;
      startPromise = null;
      readinessError = null;

      await closeServer(activeServer);
      activeStorage?.close();
    },
  });

  async function startGateway(): Promise<GatewayAddress> {
    readinessError = null;
    try {
      storage = storageFactory({ dataDir: normalizedConfig.dataDir ?? './posthorn-data' });
    } catch (error) {
      readinessError = asError(error);
    }

    server = createServer((request, response) => {
      void handleRequest({
        request,
        response,
        serviceName: normalizedConfig.serviceName ?? 'posthorn',
        maxBodyBytes: normalizedConfig.maxBodyBytes ?? 1_000_000,
        deliveryRequestTimeoutMs: normalizedConfig.worker?.requestTimeoutMs ?? 10_000,
        adminToken: normalizeAdminToken(normalizedConfig.adminToken),
        getStorage: () => storage,
        getReadinessError: () => readinessError,
        readinessProbe,
        deliveryFetch,
        now,
        startedAt,
      }).catch((error: unknown) => {
        if (!response.headersSent) {
          writeJson(response, 500, { error: { code: 'internal_error', message: 'Internal server error.' } });
          return;
        }
        response.destroy(asError(error));
      });
    });

    const host = normalizedConfig.host ?? '0.0.0.0';
    const port = normalizedConfig.port ?? 3000;
    try {
      address = await listen(server, host, port);
      return address;
    } catch (error) {
      const failedServer = server;
      const failedStorage = storage;
      server = null;
      storage = null;
      address = null;
      readinessError = null;
      await closeServer(failedServer);
      failedStorage?.close();
      throw error;
    }
  }
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly serviceName: string;
  readonly maxBodyBytes: number;
  readonly deliveryRequestTimeoutMs: number;
  readonly adminToken: string | null;
  readonly getStorage: () => PosthornStorage | null;
  readonly getReadinessError: () => Error | null;
  readonly readinessProbe: (storage: PosthornStorage) => void;
  readonly deliveryFetch: DeliveryFetch;
  readonly now: () => Date;
  readonly startedAt: Date;
}

async function handleRequest(context: RequestContext): Promise<void> {
  let url: URL;
  try {
    url = new URL(context.request.url ?? '/', 'http://localhost');
  } catch {
    writeJson(context.response, 400, { error: { code: 'invalid_request', message: 'Invalid request target.' } });
    return;
  }
  if (url.pathname === '/healthz') {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }
    writeJson(context.response, 200, { status: 'ok', service: context.serviceName });
    return;
  }

  if (url.pathname === '/readyz') {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }
    const storage = context.getStorage();
    const readinessError = context.getReadinessError();
    if (storage === null || readinessError !== null) {
      writeJson(context.response, 503, { error: { code: 'internal_error', message: 'Storage is not ready.' } });
      return;
    }
    try {
      context.readinessProbe(storage);
      writeJson(context.response, 200, { status: 'ok', service: context.serviceName });
    } catch {
      writeJson(context.response, 503, { error: { code: 'internal_error', message: 'Storage is not ready.' } });
    }
    return;
  }

  if (url.pathname === '/openapi.json') {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }
    writeJson(context.response, 200, createOpenApiDocument());
    return;
  }

  if (url.pathname === '/dashboard' || url.pathname === '/dashboard/tenant') {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }
    writeText(
      context.response,
      200,
      url.pathname === '/dashboard' ? renderAdminDashboardPage() : renderTenantDashboardPage(),
      { 'content-type': 'text/html; charset=utf-8' },
    );
    return;
  }

  if (url.pathname === '/metrics') {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }
    const storage = context.getStorage();
    const readinessError = context.getReadinessError();
    if (storage === null || readinessError !== null) {
      writeJson(context.response, 503, { error: { code: 'internal_error', message: 'Storage is not ready.' } });
      return;
    }
    try {
      context.readinessProbe(storage);
    } catch {
      writeJson(context.response, 503, { error: { code: 'internal_error', message: 'Storage is not ready.' } });
      return;
    }
    writeText(context.response, 200, renderPrometheusMetrics(storage, { now: context.now(), startedAt: context.startedAt }), {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    return;
  }

  if (url.pathname === '/v1/admin/apps' || adminAppPathFromPath(url.pathname) !== null || adminApiKeyPathFromPath(url.pathname) !== null) {
    await handleAdminRequest(context, url);
    return;
  }

  if (url.pathname === '/v1/usage') {
    await handleUsageRequest(context);
    return;
  }

  if (url.pathname === '/v1/portal/sessions') {
    await handlePortalSessionRequest(context);
    return;
  }

  if (url.pathname === '/v1/event-types' || eventTypeIdFromPath(url.pathname) !== null) {
    await handleEventTypeRequest(context, url);
    return;
  }

  if (
    url.pathname === '/v1/endpoints' ||
    endpointIdFromPath(url.pathname) !== null ||
    endpointTestPathFromPath(url.pathname) !== null
  ) {
    await handleEndpointRequest(context, url);
    return;
  }

  if (
    url.pathname === '/v1/messages' ||
    url.pathname === '/v1/messages/batch' ||
    messageIdFromPath(url.pathname) !== null ||
    messageAttemptsPathFromPath(url.pathname) !== null
  ) {
    await handleMessageRequest(context, url);
    return;
  }

  writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
}

async function handleAdminRequest(context: RequestContext, url: URL): Promise<void> {
  if (context.adminToken === null) {
    writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    return;
  }

  const scoped = authenticateAdminRequest(context);
  if (scoped === null) return;

  const apiKeyId = adminApiKeyPathFromPath(url.pathname);
  if (apiKeyId !== null) {
    if (context.request.method !== 'DELETE') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }
    if (!revokeAdminApiKey(scoped.storage, apiKeyId)) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    context.response.writeHead(204);
    context.response.end();
    return;
  }

  const appPath = adminAppPathFromPath(url.pathname);
  if (url.pathname === '/v1/admin/apps') {
    if (context.request.method === 'GET') {
      writeJson(context.response, 200, { data: listAdminApps(scoped.storage) });
      return;
    }
    if (context.request.method === 'POST') {
      const body = await readJsonBody(context);
      if (body === null) return;
      try {
        writeJson(context.response, 201, createAdminApp(scoped.storage, body));
      } catch (error) {
        writeAdminError(context.response, error);
      }
      return;
    }

    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  if (appPath === null) {
    writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    return;
  }

  if (appPath.route === 'usage') {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }

    const usage = getUsageSummary(scoped.storage, appPath.appId, context.now());
    if (usage === null) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    writeJson(context.response, 200, { usage });
    return;
  }

  if (appPath.route === 'keys') {
    if (context.request.method === 'GET') {
      const keys = listAdminApiKeys(scoped.storage, appPath.appId);
      if (keys === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }
      writeJson(context.response, 200, { data: keys });
      return;
    }
    if (context.request.method === 'POST') {
      const body = await readOptionalJsonBody(context);
      if (body === null) return;
      try {
        const apiKey = createAdminApiKey(scoped.storage, appPath.appId, body);
        if (apiKey === null) {
          writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
          return;
        }
        writeJson(context.response, 201, apiKey);
      } catch (error) {
        writeAdminError(context.response, error);
      }
      return;
    }

    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  if (context.request.method === 'GET') {
    const app = getAdminApp(scoped.storage, appPath.appId);
    if (app === null) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    writeJson(context.response, 200, { app });
    return;
  }

  if (context.request.method === 'PATCH') {
    const body = await readJsonBody(context);
    if (body === null) return;
    try {
      const app = updateAdminApp(scoped.storage, appPath.appId, body);
      if (app === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }
      writeJson(context.response, 200, { app });
    } catch (error) {
      writeAdminError(context.response, error);
    }
    return;
  }

  if (context.request.method === 'DELETE') {
    if (!deleteAdminApp(scoped.storage, appPath.appId)) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    context.response.writeHead(204);
    context.response.end();
    return;
  }

  writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
}

async function handleUsageRequest(context: RequestContext): Promise<void> {
  const scoped = authenticateTenantRequest(context);
  if (scoped === null) return;

  if (context.request.method !== 'GET') {
    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  const usage = getUsageSummary(scoped.storage, scoped.tenant.appId, context.now());
  if (usage === null) {
    writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    return;
  }

  writeJson(context.response, 200, { usage });
}

async function handlePortalSessionRequest(context: RequestContext): Promise<void> {
  const scoped = authenticateTenantRequest(context);
  if (scoped === null) return;

  if (context.request.method !== 'POST') {
    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  const body = await readOptionalJsonBody(context);
  if (body === null) return;
  try {
    const result = createPortalSession(scoped.storage, scoped.tenant.appId, body, context.now());
    if (result === null) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    writeJson(context.response, 201, result);
  } catch (error) {
    writePortalSessionError(context.response, error);
  }
}

async function handleEventTypeRequest(context: RequestContext, url: URL): Promise<void> {
  const scoped = authenticateTenantRequest(context);
  if (scoped === null) return;

  const eventTypeId = eventTypeIdFromPath(url.pathname);
  if (url.pathname === '/v1/event-types') {
    if (context.request.method === 'GET') {
      writeJson(context.response, 200, { data: listEventTypes(scoped.storage, scoped.tenant.appId) });
      return;
    }
    if (context.request.method === 'POST') {
      const body = await readJsonBody(context);
      if (body === null) return;
      try {
        writeJson(context.response, 201, createEventType(scoped.storage, scoped.tenant.appId, body, context.now()));
      } catch (error) {
        writeEventTypeError(context.response, error);
      }
      return;
    }

    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  if (eventTypeId === null) {
    writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    return;
  }

  if (context.request.method === 'GET') {
    const eventType = getEventType(scoped.storage, scoped.tenant.appId, eventTypeId);
    if (eventType === null) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    writeJson(context.response, 200, { eventType });
    return;
  }

  if (context.request.method === 'PATCH') {
    const body = await readJsonBody(context);
    if (body === null) return;
    try {
      const eventType = updateEventType(scoped.storage, scoped.tenant.appId, eventTypeId, body, context.now());
      if (eventType === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }
      writeJson(context.response, 200, { eventType });
    } catch (error) {
      writeEventTypeError(context.response, error);
    }
    return;
  }

  if (context.request.method === 'DELETE') {
    if (!archiveEventType(scoped.storage, scoped.tenant.appId, eventTypeId, context.now())) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    context.response.writeHead(204);
    context.response.end();
    return;
  }

  writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
}

async function handleEndpointRequest(context: RequestContext, url: URL): Promise<void> {
  const testEndpointId = endpointTestPathFromPath(url.pathname);
  if (testEndpointId !== null) {
    if (context.request.method !== 'POST') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }

    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;
    const body = await readJsonBody(context);
    if (body === null) return;
    try {
      const result = await sendEndpointTest(scoped.storage, scoped.tenant.appId, testEndpointId, body, {
        fetch: context.deliveryFetch,
        requestTimeoutMs: context.deliveryRequestTimeoutMs,
        now: context.now,
      });
      if (result === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }
      writeJson(context.response, 200, { test: result });
    } catch (error) {
      writeEndpointTestError(context.response, error);
    }
    return;
  }

  const endpointId = endpointIdFromPath(url.pathname);
  if (url.pathname === '/v1/endpoints') {
    if (context.request.method === 'GET') {
      const scoped = authenticateTenantRequest(context);
      if (scoped === null) return;
      writeJson(context.response, 200, { data: listEndpoints(scoped.storage, scoped.tenant.appId) });
      return;
    }
    if (context.request.method === 'POST') {
      const scoped = authenticateTenantRequest(context);
      if (scoped === null) return;
      const body = await readJsonBody(context);
      if (body === null) return;
      try {
        writeJson(context.response, 201, createEndpoint(scoped.storage, scoped.tenant.appId, body));
      } catch (error) {
        writeEndpointError(context.response, error);
      }
      return;
    }

    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  if (endpointId === null) {
    writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    return;
  }

  if (context.request.method === 'GET') {
    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;
    const endpoint = getEndpoint(scoped.storage, scoped.tenant.appId, endpointId);
    if (endpoint === null) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    writeJson(context.response, 200, { endpoint });
    return;
  }

  if (context.request.method === 'PATCH') {
    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;
    const body = await readJsonBody(context);
    if (body === null) return;
    try {
      const endpoint = updateEndpoint(scoped.storage, scoped.tenant.appId, endpointId, body);
      if (endpoint === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }
      writeJson(context.response, 200, { endpoint });
    } catch (error) {
      writeEndpointError(context.response, error);
    }
    return;
  }

  if (context.request.method === 'DELETE') {
    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;
    if (!deleteEndpoint(scoped.storage, scoped.tenant.appId, endpointId)) {
      writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    context.response.writeHead(204);
    context.response.end();
    return;
  }

  writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
}

async function handleMessageRequest(context: RequestContext, url: URL): Promise<void> {
  if (url.pathname === '/v1/messages/batch') {
    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;

    if (context.request.method !== 'POST') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }

    const body = await readJsonBody(context);
    if (body === null) return;

    try {
      writeJson(context.response, 200, acceptMessageBatch(scoped.storage, scoped.tenant.appId, body, context.now()));
    } catch (error) {
      writeMessageError(context.response, error);
    }
    return;
  }

  if (url.pathname === '/v1/messages') {
    if (context.request.method !== 'GET' && context.request.method !== 'POST') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }

    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;

    if (context.request.method === 'GET') {
      try {
        writeJson(context.response, 200, listMessages(scoped.storage, scoped.tenant.appId, {
          limit: url.searchParams.get('limit'),
          cursor: url.searchParams.get('cursor'),
        }));
      } catch (error) {
        writeMessageError(context.response, error);
      }
      return;
    }

    const body = await readJsonBody(context);
    if (body === null) return;

    try {
      writeJson(context.response, 202, acceptMessage(scoped.storage, scoped.tenant.appId, body, context.now()));
    } catch (error) {
      writeMessageError(context.response, error);
    }
    return;
  }

  const attemptsMessageId = messageAttemptsPathFromPath(url.pathname);
  if (attemptsMessageId !== null) {
    if (context.request.method !== 'GET') {
      writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      return;
    }

    const scoped = authenticateTenantRequest(context);
    if (scoped === null) return;
    try {
      const attempts = listMessageAttempts(scoped.storage, scoped.tenant.appId, attemptsMessageId, {
        limit: url.searchParams.get('limit'),
        cursor: url.searchParams.get('cursor'),
      });
      if (attempts === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }

      writeJson(context.response, 200, attempts);
    } catch (error) {
      writeMessageError(context.response, error);
    }
    return;
  }

  const messageId = messageIdFromPath(url.pathname);
  if (messageId !== null) {
    const isRetryRoute = url.pathname.endsWith('/retry');
    if (!isRetryRoute && context.request.method === 'GET') {
      const scoped = authenticateTenantRequest(context);
      if (scoped === null) return;
      const status = getMessageStatus(scoped.storage, scoped.tenant.appId, messageId);
      if (status === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }

      writeJson(context.response, 200, status);
      return;
    }

    if (isRetryRoute && context.request.method === 'POST') {
      const scoped = authenticateTenantRequest(context);
      if (scoped === null) return;
      const result = retryMessage(scoped.storage, scoped.tenant.appId, messageId, context.now());
      if (result === null) {
        writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return;
      }

      writeJson(context.response, 200, result);
      return;
    }

    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
}

function authenticateTenantRequest(context: RequestContext): ScopedRequest | null {
  const storage = context.getStorage();
  const readinessError = context.getReadinessError();
  if (storage === null || readinessError !== null) {
    writeJson(context.response, 503, { error: { code: 'internal_error', message: 'Storage is not ready.' } });
    return null;
  }

  const tenant = authenticateApiKey(storage, context.request.headers.authorization);
  if (tenant === null) {
    writeJson(context.response, 401, { error: { code: 'unauthorized', message: 'Invalid bearer token.' } });
    return null;
  }

  return { storage, tenant };
}

function authenticateAdminRequest(context: RequestContext): AdminScopedRequest | null {
  const storage = context.getStorage();
  const readinessError = context.getReadinessError();
  if (storage === null || readinessError !== null) {
    writeJson(context.response, 503, { error: { code: 'internal_error', message: 'Storage is not ready.' } });
    return null;
  }

  if (!authenticateAdminToken(context.adminToken, context.request.headers.authorization)) {
    writeJson(context.response, 401, { error: { code: 'unauthorized', message: 'Invalid bearer token.' } });
    return null;
  }

  return { storage };
}

function adminAppPathFromPath(pathname: string): AdminAppPath | null {
  const usageMatch = /^\/v1\/admin\/apps\/([^/]+)\/usage$/.exec(pathname);
  if (usageMatch !== null) return { appId: usageMatch[1], route: 'usage' };
  const keysMatch = /^\/v1\/admin\/apps\/([^/]+)\/keys$/.exec(pathname);
  if (keysMatch !== null) return { appId: keysMatch[1], route: 'keys' };
  const appMatch = /^\/v1\/admin\/apps\/([^/]+)$/.exec(pathname);
  if (appMatch !== null) return { appId: appMatch[1], route: 'app' };
  return null;
}

function adminApiKeyPathFromPath(pathname: string): string | null {
  const match = /^\/v1\/admin\/keys\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function endpointIdFromPath(pathname: string): string | null {
  const match = /^\/v1\/endpoints\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function endpointTestPathFromPath(pathname: string): string | null {
  const match = /^\/v1\/endpoints\/([^/]+)\/test$/.exec(pathname);
  return match?.[1] ?? null;
}

function eventTypeIdFromPath(pathname: string): string | null {
  const match = /^\/v1\/event-types\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function messageAttemptsPathFromPath(pathname: string): string | null {
  const match = /^\/v1\/messages\/([^/]+)\/attempts$/.exec(pathname);
  return match?.[1] ?? null;
}

function messageIdFromPath(pathname: string): string | null {
  const retryMatch = /^\/v1\/messages\/([^/]+)\/retry$/.exec(pathname);
  if (retryMatch !== null) return retryMatch[1];
  const match = /^\/v1\/messages\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function normalizeAdminToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function readJsonBody(context: RequestContext): Promise<unknown | null> {
  const bodyResult = await readRequestBody(context.request, context.maxBodyBytes);
  if (bodyResult.status === 'too_large') {
    writeJson(
      context.response,
      413,
      { error: { code: 'payload_too_large', message: 'Request body is too large.' } },
      { connection: 'close' },
    );
    return null;
  }
  if (bodyResult.status === 'aborted') {
    return null;
  }
  const rawBody = bodyResult.body;
  if (rawBody.length === 0) {
    writeJson(context.response, 400, { error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
    return null;
  }

  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    writeJson(context.response, 400, { error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
    return null;
  }
}

async function readOptionalJsonBody(context: RequestContext): Promise<unknown | null> {
  const bodyResult = await readRequestBody(context.request, context.maxBodyBytes);
  if (bodyResult.status === 'too_large') {
    writeJson(
      context.response,
      413,
      { error: { code: 'payload_too_large', message: 'Request body is too large.' } },
      { connection: 'close' },
    );
    return null;
  }
  if (bodyResult.status === 'aborted') {
    return null;
  }
  const rawBody = bodyResult.body;
  if (rawBody.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    writeJson(context.response, 400, { error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
    return null;
  }
}

function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<RequestBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      request.off('data', onData);
      request.off('error', onError);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('close', onClose);
    };

    const settle = (result: RequestBodyResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        request.resume();
        settle({ status: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onError = (error: Error) => {
      fail(error);
    };
    const onEnd = () => {
      settle({ status: 'ok', body: Buffer.concat(chunks) });
    };
    const onAborted = () => {
      settle({ status: 'aborted' });
    };
    const onClose = () => {
      if (!request.complete) {
        settle({ status: 'aborted' });
      }
    };

    request.on('data', onData);
    request.on('error', onError);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('close', onClose);
  });
}

function writeEndpointError(response: ServerResponse, error: unknown): void {
  if (error instanceof EndpointValidationError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

function writeEndpointTestError(response: ServerResponse, error: unknown): void {
  if (error instanceof EndpointTestError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

function writeEventTypeError(response: ServerResponse, error: unknown): void {
  if (error instanceof EventTypeConflictError) {
    writeJson(response, 409, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof EventTypeValidationError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

function writePortalSessionError(response: ServerResponse, error: unknown): void {
  if (error instanceof PortalSessionValidationError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

function writeAdminError(response: ServerResponse, error: unknown): void {
  if (error instanceof AdminValidationError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

function writeMessageError(response: ServerResponse, error: unknown): void {
  if (error instanceof UsageQuotaExceededError) {
    writeJson(response, 429, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof MessageConflictError) {
    writeJson(response, 409, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof MessageValidationError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function writeText(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  response.end(body);
}

interface ScopedRequest {
  readonly storage: PosthornStorage;
  readonly tenant: AuthenticatedTenant;
}

interface AdminScopedRequest {
  readonly storage: PosthornStorage;
}

interface AdminAppPath {
  readonly appId: string;
  readonly route: 'app' | 'keys' | 'usage';
}

type RequestBodyResult =
  | { readonly status: 'ok'; readonly body: Buffer }
  | { readonly status: 'too_large' }
  | { readonly status: 'aborted' };

function listen(server: Server, host: string, port: number): Promise<GatewayAddress> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const info = server.address() as AddressInfo;
      const publicHost = info.address === '::' || info.address === '0.0.0.0' ? '127.0.0.1' : info.address;
      resolve({
        host: publicHost,
        port: info.port,
        url: `http://${publicHost}:${info.port}`,
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server | null): Promise<void> {
  if (server === null || !server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
