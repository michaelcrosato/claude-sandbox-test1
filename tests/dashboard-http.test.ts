import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, loadConfig, type Gateway, type GatewayAddress } from '../src/index';

const activeGateways: Gateway[] = [];

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (gateway !== undefined) {
      await gateway.stop();
    }
  }
});

describe('dashboard HTTP pages', () => {
  it('serves the admin dashboard without embedding credentials', async () => {
    const { address } = await startGateway();

    const response = await fetch(`${address.url}/dashboard`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<h1>Admin Dashboard</h1>');
    expect(html).toContain('Waiting for admin token.');
    expect(html).toContain('No tenant created yet.');
    expect(html).toContain('Loading tenants...');
    expect(html).toContain('Tenant created.');
    expect(html).toContain('/v1/admin/apps');
    expect(html).toContain('/v1/admin/apps/');
    expect(html).toContain('/v1/admin/keys/');
    expect(html).toContain('Shown once');
    expect(html).not.toContain('phk_');
    expect(html).not.toContain('whsec_');
    expect(html).not.toContain('sha256:');
  });

  it('serves the tenant dashboard with message history and audit-log flows', async () => {
    const { address } = await startGateway();

    const response = await fetch(`${address.url}/dashboard/tenant`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<h1>Tenant Dashboard</h1>');
    expect(html).toContain('Waiting for API key.');
    expect(html).toContain('No messages yet.');
    expect(html).toContain('Loading attempts...');
    expect(html).toContain('/v1/messages');
    expect(html).toContain('/v1/messages/');
    expect(html).toContain('/v1/usage');
    expect(html).toContain('/v1/endpoints');
    expect(html).toContain('data-state="empty"');
    expect(html).toContain(", 'loading',");
    expect(html).toContain(", 'error',");
    expect(html).toContain(", 'success',");
    expect(html).not.toContain('phk_');
    expect(html).not.toContain('whsec_');
    expect(html).not.toContain('sha256:');
  });

  it('rejects unsupported dashboard methods with the standard error envelope', async () => {
    const { address } = await startGateway();

    const response = await fetch(`${address.url}/dashboard`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: { code: 'method_not_allowed', message: 'Method not allowed.' },
    });
  });
});

async function startGateway(): Promise<{ address: GatewayAddress }> {
  const gateway = createGateway({
    ...loadConfig({
      POSTHORN_HOST: '127.0.0.1',
      POSTHORN_DATA_DIR: ':memory:',
    }),
    port: 0,
  });
  activeGateways.push(gateway);
  return { address: await gateway.start() };
}
