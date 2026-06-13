import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const IMPLEMENTED_POSTHORN_METRICS = new Set([
  'posthorn_messages_ingested_total',
  'posthorn_deliveries_total',
  'posthorn_delivery_tasks',
  'posthorn_dead_letter_tasks',
  'posthorn_uptime_seconds',
  'posthorn_build_info',
]);

const REQUIRED_DASHBOARD_METRICS = [
  'posthorn_messages_ingested_total',
  'posthorn_deliveries_total',
  'posthorn_delivery_tasks',
  'posthorn_dead_letter_tasks',
  'posthorn_uptime_seconds',
  'posthorn_build_info',
] as const;

const REQUIRED_ALERTS = [
  'PosthornTargetDown',
  'PosthornTargetMissing',
  'PosthornDeadLetterBacklog',
  'PosthornNewDeadLetters',
  'PosthornStuckDelivering',
  'PosthornRetryingSpike',
] as const;

describe('monitoring artifacts', () => {
  it('defines an importable Grafana dashboard for implemented Posthorn metrics', () => {
    const raw = read('docs/grafana-dashboard.json');
    const dashboard = JSON.parse(raw) as {
      readonly title: unknown;
      readonly templating?: { readonly list?: readonly unknown[] };
      readonly panels?: readonly unknown[];
    };

    expect(dashboard.title).toBe('Posthorn Overview');
    expect(dashboard.panels?.length).toBeGreaterThanOrEqual(6);
    expect(raw).toContain('"name": "DS_PROMETHEUS"');
    expect(raw).toContain(['"uid": "', '{DS_PROMETHEUS}"'].join('$'));
    for (const metric of REQUIRED_DASHBOARD_METRICS) {
      expect(raw).toContain(metric);
    }
    expect(extractPosthornMetrics(raw)).toEqual(IMPLEMENTED_POSTHORN_METRICS);
    expect(raw).not.toContain('localhost');
    expect(raw).not.toContain('phk_');
    expect(raw).not.toContain('whsec_');
  });

  it('defines Prometheus alerts only for implemented Posthorn metrics', () => {
    const raw = read('docs/prometheus-alerts.yml');

    expect(raw).toContain('groups:');
    expect(raw).toContain('up{job="posthorn"}');
    for (const alertName of REQUIRED_ALERTS) {
      expect(raw).toContain(`alert: ${alertName}`);
    }
    expect(extractPosthornMetrics(raw)).toEqual(
      new Set(['posthorn_deliveries_total', 'posthorn_delivery_tasks']),
    );
    expect(raw).not.toContain('POSTHORN_ADMIN_TOKEN');
    expect(raw).not.toContain('phk_');
    expect(raw).not.toContain('whsec_');
  });

  it('links the monitoring artifacts from operator docs', () => {
    const readme = read('README.md');
    const deploy = read('docs/DEPLOY.md');

    expect(readme).toContain('docs/prometheus-alerts.yml');
    expect(readme).toContain('docs/grafana-dashboard.json');
    expect(deploy).toContain('docs/prometheus-alerts.yml');
    expect(deploy).toContain('docs/grafana-dashboard.json');
  });
});

function extractPosthornMetrics(input: string): Set<string> {
  return new Set(input.match(/\bposthorn_[a-z_]+(?:_total|_seconds|_info|_tasks)?\b/g) ?? []);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
