import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, loadConfig, type Gateway, type PosthornStorage } from '../src/index';

const activeGateways: Gateway[] = [];

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (gateway !== undefined) {
      await gateway.stop();
    }
  }
});

describe('HTTP gateway', () => {
  it('starts and stops without leaking the listening server', async () => {
    const gateway = makeGateway();
    activeGateways.push(gateway);

    const address = await gateway.start();
    expect(address.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await gateway.stop();
    activeGateways.pop();

    await expect(fetch(`${address.url}/healthz`)).rejects.toThrow();
  });

  it('coalesces concurrent starts so stop closes the only listener', async () => {
    const gateway = makeGateway();
    activeGateways.push(gateway);

    const [first, second] = await Promise.all([gateway.start(), gateway.start()]);
    expect(second).toEqual(first);

    await gateway.stop();
    activeGateways.pop();

    await expect(fetch(`${first.url}/healthz`)).rejects.toThrow();
  });

  it('cleans up storage when the server cannot listen', async () => {
    let closed = false;
    const db = new DatabaseSync(':memory:');
    const gateway = createGateway(
      {
        ...loadConfig({
          POSTHORN_HOST: '127.0.0.1',
          POSTHORN_DATA_DIR: ':memory:',
        }),
        port: -1,
      },
      {
        openStorage: () => makeTrackedStorage(db, () => {
          closed = true;
        }),
      },
    );
    activeGateways.push(gateway);

    await expect(gateway.start()).rejects.toThrow();
    expect(closed).toBe(true);
    await expect(gateway.stop()).resolves.toBeUndefined();
    activeGateways.pop();
  });

  it('treats absolute-form health targets as health checks', async () => {
    const gateway = makeGateway();
    activeGateways.push(gateway);
    const address = await gateway.start();

    const rawResponse = await sendRawRequest(
      address.port,
      `GET http://127.0.0.1:${address.port}/healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );

    expect(rawResponse).toContain('HTTP/1.1 200 OK');
    expect(rawResponse).toContain('"status":"ok"');
  });

  it('serves unauthenticated health checks', async () => {
    const gateway = makeGateway();
    activeGateways.push(gateway);
    const address = await gateway.start();

    const response = await fetch(`${address.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'posthorn',
    });
  });

  it('serves readiness checks when storage can be queried', async () => {
    const gateway = makeGateway();
    activeGateways.push(gateway);
    const address = await gateway.start();

    const response = await fetch(`${address.url}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'posthorn',
    });
  });

  it('returns 503 readiness when the storage probe fails', async () => {
    const gateway = makeGateway({
      readinessProbe: () => {
        throw new Error('synthetic readiness failure');
      },
    });
    activeGateways.push(gateway);
    const address = await gateway.start();

    const response = await fetch(`${address.url}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'internal_error', message: 'Storage is not ready.' },
    });
  });

  it('returns 400 for malformed request targets instead of crashing', async () => {
    const gateway = makeGateway();
    activeGateways.push(gateway);
    const address = await gateway.start();

    const rawResponse = await sendRawRequest(
      address.port,
      'GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
    );

    expect(rawResponse).toContain('HTTP/1.1 400 Bad Request');
    expect(rawResponse).toContain('"code":"invalid_request"');
    const health = await fetch(`${address.url}/healthz`);
    expect(health.status).toBe(200);
  });

  it('retries on EADDRINUSE by incrementing port up to basePort + 100', async () => {
    const tempGateway = createGateway({
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 0,
    });
    activeGateways.push(tempGateway);
    const tempAddr = await tempGateway.start();
    const busyPort = tempAddr.port;

    const conflictingGateway = createGateway({
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: busyPort,
    });
    activeGateways.push(conflictingGateway);

    const conflictingAddr = await conflictingGateway.start();
    expect(conflictingAddr.port).toBe(busyPort + 1);

    await conflictingGateway.stop();
    activeGateways.pop();
    await tempGateway.stop();
    activeGateways.pop();
  });
});

function makeGateway(dependencies?: Parameters<typeof createGateway>[1]): Gateway {
  return createGateway(
    {
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 0,
    },
    dependencies,
  );
}

function sendRawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(payload);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function makeTrackedStorage(db: DatabaseSync, onClose: () => void): PosthornStorage {
  return {
    databasePath: ':memory:',
    db,
    initializeSchema() {
      db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    },
    listTables() {
      return [];
    },
    close() {
      onClose();
      db.close();
    },
  };
}
