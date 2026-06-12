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
