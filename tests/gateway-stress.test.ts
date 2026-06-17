import { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, loadConfig } from '../src/index';

describe('Gateway Stress and Extreme Ports Tests', () => {
  const originalListen = Server.prototype.listen;

  afterEach(() => {
    (Server.prototype as any).listen = originalListen;
  });

  it('fails loadConfig with extreme or invalid ports in env', () => {
    // Negative port
    expect(() => loadConfig({ POSTHORN_PORT: '-1' })).toThrow('POSTHORN_PORT must be >= 1.');
    // Too large port
    expect(() => loadConfig({ POSTHORN_PORT: '65536' })).toThrow('POSTHORN_PORT must be <= 65535.');
    // Non-integer
    expect(() => loadConfig({ POSTHORN_PORT: 'abc' })).toThrow('POSTHORN_PORT must be an integer.');
    // Not safe integer
    expect(() => loadConfig({ POSTHORN_PORT: '99999999999999999999' })).toThrow('POSTHORN_PORT must be a safe integer.');
  });

  it('handles negative or invalid ports directly in createGateway without crashing', async () => {
    // Negative port direct config
    const gatewayNeg = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: -1,
    });
    await expect(gatewayNeg.start()).rejects.toThrow();
    await gatewayNeg.stop();

    // Large port direct config
    const gatewayLarge = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: 70000,
    });
    await expect(gatewayLarge.start()).rejects.toThrow();
    await gatewayLarge.stop();
  });

  it('succeeds to bind on 101st port (basePort + 100) when exactly 100 ports are occupied', async () => {
    let listenCount = 0;
    const attemptedPorts: number[] = [];
    const basePort = 3000;

    (Server.prototype as any).listen = function (this: Server, port: any, host: any, cb: any) {
      listenCount++;
      attemptedPorts.push(port);
      if (listenCount <= 100) {
        const err = new Error('listen EADDRINUSE: address already in use 127.0.0.1:' + port);
        (err as any).code = 'EADDRINUSE';
        process.nextTick(() => {
          this.emit('error', err);
        });
      } else {
        process.nextTick(() => {
          this.address = () => ({ address: '127.0.0.1', family: 'IPv4', port } as any);
          this.emit('listening');
          if (cb) cb();
        });
      }
      return this;
    };

    const gateway = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: basePort,
    });

    const addr = await gateway.start();
    expect(addr.port).toBe(basePort + 100);
    expect(listenCount).toBe(101);
    expect(attemptedPorts[0]).toBe(basePort);
    expect(attemptedPorts[100]).toBe(basePort + 100);

    await gateway.stop();
  });

  it('throws EADDRINUSE after 101 attempts (up to basePort + 100) when 101 ports are occupied', async () => {
    let listenCount = 0;
    const attemptedPorts: number[] = [];
    const basePort = 3000;

    (Server.prototype as any).listen = function (this: Server, port: any, host: any, cb: any) {
      listenCount++;
      attemptedPorts.push(port);
      const err = new Error('listen EADDRINUSE: address already in use 127.0.0.1:' + port);
      (err as any).code = 'EADDRINUSE';
      process.nextTick(() => {
        this.emit('error', err);
      });
      return this;
    };

    const gateway = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: basePort,
    });

    await expect(gateway.start()).rejects.toThrow('EADDRINUSE');
    expect(listenCount).toBe(101);
    expect(attemptedPorts[0]).toBe(basePort);
    expect(attemptedPorts[100]).toBe(basePort + 100);

    await gateway.stop();
  });

  it('throws EADDRINUSE cleanly without throwing RangeError when port scan would exceed 65535', async () => {
    let listenCount = 0;
    const attemptedPorts: number[] = [];
    const basePort = 65500;

    (Server.prototype as any).listen = function (this: Server, port: any, _host: any, _cb: any) {
      listenCount++;
      attemptedPorts.push(port);
      const err = new Error('listen EADDRINUSE: address already in use 127.0.0.1:' + port);
      (err as any).code = 'EADDRINUSE';
      process.nextTick(() => {
        this.emit('error', err);
      });
      return this;
    };

    const gateway = createGateway({
      host: '127.0.0.1',
      dataDir: ':memory:',
      port: basePort,
    });

    await expect(gateway.start()).rejects.toThrow('EADDRINUSE');
    expect(listenCount).toBe(36);
    expect(attemptedPorts[0]).toBe(65500);
    expect(attemptedPorts[35]).toBe(65535);

    await gateway.stop();
  });
});
