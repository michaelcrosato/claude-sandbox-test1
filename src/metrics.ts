import type { PosthornStorage } from './storage';

export interface MetricsSnapshotOptions {
  readonly now?: Date;
  readonly startedAt?: Date;
  readonly version?: string;
}

interface LabelledValue {
  readonly label: string;
  readonly value: number;
}

const DEFAULT_VERSION = '0.0.0';
const DELIVERY_OUTCOMES = ['succeeded', 'retrying', 'dead_lettered'] as const;
const DELIVERY_STATUSES = ['pending', 'delivering', 'succeeded', 'dead_letter'] as const;
const DEAD_LETTER_REASONS = [
  'http_###',
  'timeout',
  'network_error',
  'invalid_payload',
  'signing_secret_unavailable',
  'unknown',
  'other',
] as const;

export function renderPrometheusMetrics(
  storage: PosthornStorage,
  options: MetricsSnapshotOptions = {},
): string {
  const now = options.now ?? new Date();
  const startedAt = options.startedAt ?? now;
  const version = options.version ?? DEFAULT_VERSION;
  const lines: string[] = [];

  addHelp(lines, 'posthorn_messages_ingested_total', 'Total accepted messages.');
  addType(lines, 'posthorn_messages_ingested_total', 'counter');
  lines.push(`posthorn_messages_ingested_total ${sumAcceptedMessages(storage)}`);

  addHelp(lines, 'posthorn_deliveries_total', 'Total delivery attempts by terminal or retrying outcome.');
  addType(lines, 'posthorn_deliveries_total', 'counter');
  for (const item of deliveryOutcomeCounts(storage)) {
    lines.push(`posthorn_deliveries_total{outcome="${item.label}"} ${item.value}`);
  }

  addHelp(lines, 'posthorn_delivery_tasks', 'Current delivery task count by status.');
  addType(lines, 'posthorn_delivery_tasks', 'gauge');
  for (const item of deliveryStatusCounts(storage)) {
    lines.push(`posthorn_delivery_tasks{status="${item.label}"} ${item.value}`);
  }

  addHelp(lines, 'posthorn_dead_letter_tasks', 'Current dead-letter task count by bounded failure reason.');
  addType(lines, 'posthorn_dead_letter_tasks', 'gauge');
  for (const item of deadLetterReasonCounts(storage)) {
    lines.push(`posthorn_dead_letter_tasks{reason="${item.label}"} ${item.value}`);
  }

  addHelp(lines, 'posthorn_uptime_seconds', 'Gateway process uptime in seconds.');
  addType(lines, 'posthorn_uptime_seconds', 'gauge');
  lines.push(`posthorn_uptime_seconds ${uptimeSeconds(now, startedAt)}`);

  addHelp(lines, 'posthorn_build_info', 'Build and version information.');
  addType(lines, 'posthorn_build_info', 'gauge');
  lines.push(`posthorn_build_info{version="${escapeLabelValue(version)}"} 1`);

  return `${lines.join('\n')}\n`;
}

function addHelp(lines: string[], name: string, help: string): void {
  lines.push(`# HELP ${name} ${help}`);
}

function addType(lines: string[], name: string, type: 'counter' | 'gauge'): void {
  lines.push(`# TYPE ${name} ${type}`);
}

function sumAcceptedMessages(storage: PosthornStorage): number {
  const row = storage.db
    .prepare('SELECT COALESCE(SUM(messages_accepted), 0) AS count FROM usage_months')
    .get() as CountRow | undefined;
  return numberFromRow(row);
}

function deliveryOutcomeCounts(storage: PosthornStorage): readonly LabelledValue[] {
  const rows = storage.db
    .prepare(
      `
        SELECT outcome, COUNT(*) AS count
        FROM delivery_attempts
        GROUP BY outcome
      `,
    )
    .all() as unknown as Array<{ readonly outcome: unknown; readonly count: unknown }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(normalizeDeliveryOutcome(row.outcome), (counts.get(normalizeDeliveryOutcome(row.outcome)) ?? 0) + Number(row.count));
  }

  return DELIVERY_OUTCOMES.map((outcome) => ({ label: outcome, value: counts.get(outcome) ?? 0 }));
}

function deliveryStatusCounts(storage: PosthornStorage): readonly LabelledValue[] {
  const rows = storage.db
    .prepare(
      `
        SELECT status, COUNT(*) AS count
        FROM deliveries
        GROUP BY status
      `,
    )
    .all() as unknown as Array<{ readonly status: unknown; readonly count: unknown }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const status = normalizeDeliveryStatus(row.status);
    counts.set(status, (counts.get(status) ?? 0) + Number(row.count));
  }

  return DELIVERY_STATUSES.map((status) => ({ label: status, value: counts.get(status) ?? 0 }));
}

function deadLetterReasonCounts(storage: PosthornStorage): readonly LabelledValue[] {
  const rows = storage.db
    .prepare(
      `
        SELECT last_error, COUNT(*) AS count
        FROM deliveries
        WHERE status = 'dead_letter'
        GROUP BY last_error
      `,
    )
    .all() as unknown as Array<{ readonly last_error: unknown; readonly count: unknown }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = normalizeDeadLetterReason(row.last_error);
    counts.set(reason, (counts.get(reason) ?? 0) + Number(row.count));
  }

  return DEAD_LETTER_REASONS.map((reason) => ({ label: reason, value: counts.get(reason) ?? 0 }));
}

function normalizeDeliveryOutcome(value: unknown): (typeof DELIVERY_OUTCOMES)[number] {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'dead_letter') return 'dead_lettered';
  return 'retrying';
}

function normalizeDeliveryStatus(value: unknown): (typeof DELIVERY_STATUSES)[number] {
  if (value === 'delivering') return 'delivering';
  if (value === 'succeeded') return 'succeeded';
  if (value === 'dead_letter') return 'dead_letter';
  return 'pending';
}

function normalizeDeadLetterReason(value: unknown): (typeof DEAD_LETTER_REASONS)[number] {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  if (/^http_[0-9]{3}$/.test(value)) return 'http_###';
  if (
    value === 'timeout' ||
    value === 'network_error' ||
    value === 'invalid_payload' ||
    value === 'signing_secret_unavailable'
  ) {
    return value;
  }

  return 'other';
}

function uptimeSeconds(now: Date, startedAt: Date): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function numberFromRow(row: CountRow | undefined): number {
  return row === undefined ? 0 : Number(row.count);
}

interface CountRow {
  readonly count: unknown;
}
