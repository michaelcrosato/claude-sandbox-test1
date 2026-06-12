import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticateApiKey, type AuthenticatedTenant } from './auth';
import type { PosthornConfig } from './config';
import {
  createEndpoint,
  deleteEndpoint,
  EndpointValidationError,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
} from './endpoints';
import { acceptMessage, listMessageAttempts, MessageConflictError, MessageValidationError } from './messages';
import { openStorage, type PosthornStorage } from './storage';

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
        getStorage: () => storage,
        getReadinessError: () => readinessError,
        readinessProbe,
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
  readonly getStorage: () => PosthornStorage | null;
  readonly getReadinessError: () => Error | null;
  readonly readinessProbe: (storage: PosthornStorage) => void;
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
      writeJson(context.response, 503, { status: 'error', service: context.serviceName });
      return;
    }
    try {
      context.readinessProbe(storage);
      writeJson(context.response, 200, { status: 'ok', service: context.serviceName });
    } catch {
      writeJson(context.response, 503, { status: 'error', service: context.serviceName });
    }
    return;
  }

  if (url.pathname === '/v1/endpoints' || endpointIdFromPath(url.pathname) !== null) {
    await handleEndpointRequest(context, url);
    return;
  }

  if (url.pathname === '/v1/messages' || messageAttemptsPathFromPath(url.pathname) !== null) {
    await handleMessageRequest(context, url);
    return;
  }

  writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
}

async function handleEndpointRequest(context: RequestContext, url: URL): Promise<void> {
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

  if (context.request.method !== 'POST') {
    writeJson(context.response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  const scoped = authenticateTenantRequest(context);
  if (scoped === null) return;
  const body = await readJsonBody(context);
  if (body === null) return;

  try {
    writeJson(context.response, 202, acceptMessage(scoped.storage, scoped.tenant.appId, body));
  } catch (error) {
    writeMessageError(context.response, error);
  }
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

function endpointIdFromPath(pathname: string): string | null {
  const match = /^\/v1\/endpoints\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function messageAttemptsPathFromPath(pathname: string): string | null {
  const match = /^\/v1\/messages\/([^/]+)\/attempts$/.exec(pathname);
  return match?.[1] ?? null;
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

function writeMessageError(response: ServerResponse, error: unknown): void {
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

interface ScopedRequest {
  readonly storage: PosthornStorage;
  readonly tenant: AuthenticatedTenant;
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
