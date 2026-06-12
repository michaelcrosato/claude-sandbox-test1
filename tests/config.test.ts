import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/index';

describe('loadConfig', () => {
  it('parses documented defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '0.0.0.0',
      port: 3000,
      dataDir: './posthorn-data',
      maxBodyBytes: 1_000_000,
      adminToken: null,
      worker: {
        batchSize: 16,
        concurrency: 8,
        requestTimeoutMs: 10_000,
        idlePollMs: 1_000,
        visibilityTimeoutMs: 30_000,
        attemptBudget: 8,
      },
      endpointAutoDisableAfterMs: 432_000_000,
    });
  });

  it('parses documented overrides', () => {
    expect(
      loadConfig({
        POSTHORN_HOST: '127.0.0.1',
        POSTHORN_PORT: '4000',
        POSTHORN_DATA_DIR: ':memory:',
        POSTHORN_MAX_BODY_BYTES: '2048',
        POSTHORN_ADMIN_TOKEN: '0123456789abcdef',
        POSTHORN_WORKER_BATCH_SIZE: '4',
        POSTHORN_WORKER_CONCURRENCY: '2',
        POSTHORN_WORKER_REQUEST_TIMEOUT_MS: '1500',
        POSTHORN_WORKER_IDLE_POLL_MS: '250',
        POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS: '5000',
        POSTHORN_WORKER_ATTEMPT_BUDGET: '3',
        POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS: '0',
      }),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 4000,
      dataDir: ':memory:',
      maxBodyBytes: 2048,
      adminToken: '0123456789abcdef',
      worker: {
        batchSize: 4,
        concurrency: 2,
        requestTimeoutMs: 1500,
        idlePollMs: 250,
        visibilityTimeoutMs: 5000,
        attemptBudget: 3,
      },
      endpointAutoDisableAfterMs: 0,
    });
  });

  it.each([
    ['POSTHORN_PORT', 'abc'],
    ['POSTHORN_PORT', '0'],
    ['POSTHORN_PORT', '65536'],
    ['POSTHORN_MAX_BODY_BYTES', '-1'],
    ['POSTHORN_WORKER_BATCH_SIZE', '1.5'],
    ['POSTHORN_WORKER_CONCURRENCY', ''],
    ['POSTHORN_WORKER_REQUEST_TIMEOUT_MS', 'NaN'],
    ['POSTHORN_WORKER_IDLE_POLL_MS', '-10'],
    ['POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS', '0'],
    ['POSTHORN_WORKER_ATTEMPT_BUDGET', '0'],
    ['POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS', '-1'],
  ])('rejects invalid numeric config %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('rejects short admin tokens when admin is enabled', () => {
    expect(() => loadConfig({ POSTHORN_ADMIN_TOKEN: 'too-short' })).toThrow('POSTHORN_ADMIN_TOKEN');
  });
});
