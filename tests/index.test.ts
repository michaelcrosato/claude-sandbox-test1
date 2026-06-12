import { describe, expect, it } from 'vitest';

import { createGateway, loadConfig } from '../src/index';

describe('Posthorn product entry point', () => {
  it('exports a minimal gateway factory', () => {
    const gateway = createGateway({ serviceName: 'posthorn-test' });

    expect(gateway.serviceName).toBe('posthorn-test');
    expect(gateway.config).toEqual({ serviceName: 'posthorn-test' });
    expect(gateway.start).toEqual(expect.any(Function));
    expect(gateway.stop).toEqual(expect.any(Function));
  });

  it('keeps loaded config on the gateway shape', () => {
    const config = loadConfig({ POSTHORN_DATA_DIR: ':memory:' });
    const gateway = createGateway(config);

    expect(gateway.serviceName).toBe('posthorn');
    expect(gateway.config).toMatchObject({
      dataDir: ':memory:',
      port: 3000,
    });
  });
});
