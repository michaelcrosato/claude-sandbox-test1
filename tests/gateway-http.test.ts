import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, loadConfig, type Gateway } from '../src/index';

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
      status: 'error',
      service: 'posthorn',
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
