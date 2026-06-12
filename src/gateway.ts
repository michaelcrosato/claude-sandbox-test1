import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PosthornConfig } from './config';
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

      readinessError = null;
      try {
        storage = storageFactory({ dataDir: normalizedConfig.dataDir ?? './posthorn-data' });
      } catch (error) {
        readinessError = asError(error);
      }

      server = createServer((request, response) => {
        handleRequest({
          request,
          response,
          serviceName: normalizedConfig.serviceName ?? 'posthorn',
          getStorage: () => storage,
          getReadinessError: () => readinessError,
          readinessProbe,
        });
      });

      const host = normalizedConfig.host ?? '0.0.0.0';
      const port = normalizedConfig.port ?? 3000;
      address = await listen(server, host, port);
      return address;
    },
    async stop() {
      const activeServer = server;
      const activeStorage = storage;
      server = null;
      storage = null;
      address = null;
      readinessError = null;

      await closeServer(activeServer);
      activeStorage?.close();
    },
  });
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly serviceName: string;
  readonly getStorage: () => PosthornStorage | null;
  readonly getReadinessError: () => Error | null;
  readonly readinessProbe: (storage: PosthornStorage) => void;
}

function handleRequest(context: RequestContext): void {
  const url = new URL(context.request.url ?? '/', 'http://localhost');
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

  writeJson(context.response, 404, { error: { code: 'not_found', message: 'Not found.' } });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

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
