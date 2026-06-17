import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockServer extends EventEmitter {
  listening = false;
  listenCalls: { port: number; host: string }[] = [];
  shouldFailCount = 0;
  addressInfo: { address: string; family: string; port: number } | null = null;

  listen(port: number, host: string) {
    this.listenCalls.push({ port, host });
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError(`The port parameter should be >= 0 and < 65536. Received ${port}.`);
    }
    process.nextTick(() => {
      if (this.shouldFailCount > 0) {
        this.shouldFailCount--;
        const err: any = new Error('listen EADDRINUSE: address already in use');
        err.code = 'EADDRINUSE';
        this.emit('error', err);
      } else {
        this.listening = true;
        this.addressInfo = { address: host, family: 'IPv4', port };
        this.emit('listening');
      }
    });
    return this;
  }

  address() {
    return this.addressInfo;
  }

  close(cb?: (err?: Error) => void) {
    this.listening = false;
    process.nextTick(() => {
      if (cb) cb();
    });
    return this;
  }
}

const activeMockServer = new MockServer();

// Mock node:http to return our mock server instance
vi.mock('node:http', () => {
  return {
    createServer: () => activeMockServer,
  };
});

// Import createGateway and loadConfig AFTER vi.mock so the mocked node:http is used
import { createGateway, loadConfig } from '../src/index';

describe('gateway challenger tests', () => {
  beforeEach(() => {
    activeMockServer.listening = false;
    activeMockServer.listenCalls = [];
    activeMockServer.shouldFailCount = 0;
    activeMockServer.addressInfo = null;
    activeMockServer.removeAllListeners();
  });

  it('tries exactly 101 times and succeeds on the 101st attempt if 100 ports are occupied', async () => {
    activeMockServer.shouldFailCount = 100;

    const gateway = createGateway({
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 3000,
    });

    const addr = await gateway.start();
    expect(addr.port).toBe(3100);
    expect(activeMockServer.listenCalls).toHaveLength(101);
    
    // Check that we checked ports 3000 through 3100
    expect(activeMockServer.listenCalls[0].port).toBe(3000);
    expect(activeMockServer.listenCalls[100].port).toBe(3100);

    await gateway.stop();
  });

  it('fails with EADDRINUSE after 101 attempts if 101 ports are occupied', async () => {
    activeMockServer.shouldFailCount = 101; // tries 3000 to 3100 (101 ports), all fail

    const gateway = createGateway({
      ...loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_DATA_DIR: ':memory:',
      }),
      port: 3000,
    });

    await expect(gateway.start()).rejects.toThrow('EADDRINUSE');
    expect(activeMockServer.listenCalls).toHaveLength(101);
    expect(activeMockServer.listenCalls[0].port).toBe(3000);
    expect(activeMockServer.listenCalls[100].port).toBe(3100);
  });

  it('rejects extreme ports in configuration loading', () => {
    // Negative port
    expect(() => loadConfig({ POSTHORN_PORT: '-10' })).toThrow('POSTHORN_PORT must be >= 1');
    
    // Too large port
    expect(() => loadConfig({ POSTHORN_PORT: '70000' })).toThrow('POSTHORN_PORT must be <= 65535');

    // Ephemeral 0 port is not allowed in config load (min is 1)
    expect(() => loadConfig({ POSTHORN_PORT: '0' })).toThrow('POSTHORN_PORT must be >= 1');
  });

  it('correctly handles extreme port direct inputs in createGateway without retrying', async () => {
    // Negative port directly in config bypasses loadConfig but fails in createGateway
    const gatewayNegative = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: -1,
    });
    await expect(gatewayNegative.start()).rejects.toThrow();

    // Port larger than 65535
    const gatewayLarge = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 70000,
    });
    await expect(gatewayLarge.start()).rejects.toThrow();
  });
});
