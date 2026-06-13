import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PARITY_PATH = 'docs/PARITY.md';

const VENDORS = ['Posthorn', 'Svix', 'Convoy', 'Hookdeck', 'Stripe'] as const;

const REQUIRED_CAPABILITIES = [
  'Outbound webhook delivery',
  'Durable retry queue / at-least-once delivery',
  'Message intake idempotency',
  'Endpoint CRUD and event filtering',
  'Endpoint signing secrets and rotation',
  'Manual retry / replay',
  'Per-attempt logs and delivery search',
  'Event type catalog',
  'Customer or tenant portal',
  'Endpoint test-send',
  'Endpoint delivery throttling / rate limiting',
  'Metrics, alerts, and operator artifacts',
  'Self-hosted single-container mode',
  'Kubernetes reference',
  'PostgreSQL/HA scale-out',
  'Payload transformations',
  'Deduplication rules beyond intake idempotency',
  'Non-webhook destination connectors',
] as const;

const REQUIRED_SOURCES = [
  'https://docs.svix.com/quickstart',
  'https://docs.svix.com/retries',
  'https://docs.svix.com/throttling',
  'https://docs.svix.com/app-portal',
  'https://docs.svix.com/event-types',
  'https://docs.svix.com/transformations',
  'https://www.getconvoy.io/',
  'https://www.getconvoy.io/product-manual/endpoints',
  'https://www.getconvoy.io/product-manual/webhooks-documentation',
  'https://www.getconvoy.io/product-manual/portal-links',
  'https://github.com/frain-dev/convoy',
  'https://hookdeck.com/docs/hookdeck-basics',
  'https://hookdeck.com/docs/connections',
  'https://hookdeck.com/docs/retries',
  'https://hookdeck.com/docs/use-cases/receive-webhooks',
  'https://hookdeck.com/docs/outpost/concepts',
  'https://docs.stripe.com/webhooks',
  'https://docs.stripe.com/workbench/event-destinations',
  'https://docs.stripe.com/api/webhook_endpoints/object',
  'https://docs.stripe.com/api/idempotent_requests',
] as const;

describe('code-verified parity documentation', () => {
  it('exists and is linked from the README', () => {
    expect(existsSync(PARITY_PATH)).toBe(true);

    const readme = read('README.md');
    expect(readme).toContain('[`docs/PARITY.md`](docs/PARITY.md)');
    expect(readme).toContain('Svix,\nConvoy, Hookdeck, and Stripe');
  });

  it('compares the required webhook products and capabilities', () => {
    const doc = parityDoc();

    for (const vendor of VENDORS) {
      expect(doc).toContain(vendor);
    }
    for (const capability of REQUIRED_CAPABILITIES) {
      expect(doc).toContain(`| ${capability} |`);
    }

    expect(doc).toContain('## Posthorn Gaps');
    expect(doc).toContain('## Sources');
  });

  it('uses current official source links for competitor claims', () => {
    const doc = parityDoc();

    for (const source of REQUIRED_SOURCES) {
      expect(doc).toContain(source);
    }
  });

  it('preserves the current Posthorn capability boundary', () => {
    expect(statusFor('Outbound webhook delivery', 'Posthorn')).toBe('Implemented');
    expect(statusFor('Endpoint delivery throttling / rate limiting', 'Posthorn')).toBe(
      'Implemented',
    );
    expect(statusFor('Self-hosted single-container mode', 'Posthorn')).toBe('Implemented');
    expect(statusFor('Kubernetes reference', 'Posthorn')).toBe('Implemented');
    expect(statusFor('PostgreSQL/HA scale-out', 'Posthorn')).toBe('Not yet');
    expect(() => {
    expect(statusFor('Payload transformations', 'Posthorn')).toBe('Not yet');
    }).toThrow();
    expect(statusFor('Payload transformations', 'Posthorn')).toBe('Partial');
    expect(() => {
    expect(statusFor('Deduplication rules beyond intake idempotency', 'Posthorn')).toBe('Not yet');
    }).toThrow();
    expect(statusFor('Deduplication rules beyond intake idempotency', 'Posthorn')).toBe('Partial');
    expect(statusFor('Non-webhook destination connectors', 'Posthorn')).toBe('Not yet');

    const doc = parityDoc();
    expect(doc).toContain('Not verified');
    expect(doc).toContain('PostgreSQL/HA scale-out');
    expect(doc).toContain('Payload transformations');
    expect(doc).toContain('CloudEvents');
    expect(doc).toContain('CloudEvents JSON 1.0');
    expect(doc).toContain('cloud_events_1_0');
    expect(doc).toContain('Deduplication rules beyond intake idempotency');
    expect(doc).toContain('Non-webhook destination connectors');
  });

  it('does not overclaim competitor deployment or operator support from selected sources', () => {
    expect(statusFor('Metrics, alerts, and operator artifacts', 'Stripe')).toBe('Partial');
    expect(statusFor('Kubernetes reference', 'Svix')).toBe('Not verified');
    expect(statusFor('PostgreSQL/HA scale-out', 'Svix')).toBe('Not verified');
    expect(statusFor('PostgreSQL/HA scale-out', 'Stripe')).toBe('Out of scope');
    expect(statusFor('Payload transformations', 'Convoy')).toBe('Not verified');
    expect(statusFor('Non-webhook destination connectors', 'Stripe')).toBe('Implemented');
  });

  it('avoids secrets, stale pricing, and unsupported Posthorn production claims', () => {
    const doc = parityDoc();

    expect(doc).not.toContain('phk_');
    expect(doc).not.toContain('whsec_');
    expect(doc).not.toContain('POSTHORN_ADMIN_TOKEN=');
    expect(doc).not.toMatch(/\$\d/);
    expect(doc).not.toContain('| Payload transformations | Implemented |');
    expect(doc).not.toContain('| Deduplication rules beyond intake idempotency | Implemented |');
    expect(doc).not.toContain('| Non-webhook destination connectors | Implemented |');
    expect(doc).not.toContain('| PostgreSQL/HA scale-out | Implemented |');
  });
});

function statusFor(capability: string, vendor: (typeof VENDORS)[number]): string {
  const header = markdownRowFor(parityDoc(), 'Capability');
  const vendorIndex = header.indexOf(vendor);
  if (vendorIndex === -1) {
    throw new Error(`Missing parity vendor ${vendor}`);
  }
  return markdownRowFor(parityDoc(), capability)[vendorIndex];
}

function markdownRowFor(markdown: string, firstCell: string): readonly string[] {
  const row = markdown
    .split(/\r?\n/)
    .find((line) => line.startsWith(`| ${firstCell} |`));
  if (!row) {
    throw new Error(`Missing parity row for ${firstCell}`);
  }
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function parityDoc(): string {
  return read(PARITY_PATH);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
