import { describe, expect, it } from 'vitest';

import { createGateway } from '../src/index';

describe('Posthorn product entry point', () => {
  it('exports a minimal gateway factory', () => {
    const gateway = createGateway({ serviceName: 'posthorn-test' });

    expect(gateway.serviceName).toBe('posthorn-test');
    expect(gateway.config).toEqual({ serviceName: 'posthorn-test' });
  });
});
