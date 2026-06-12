import type { PosthornStorage } from './storage';

export type UsageQuotaExceededErrorCode = 'quota_exceeded';

export interface UsageQuotaStatus {
  readonly monthlyMessageQuota: number | null;
  readonly remaining: number | null;
  readonly exceeded: boolean;
}

export interface UsageSummary {
  readonly appId: string;
  readonly month: string;
  readonly messagesAccepted: number;
  readonly deliveryAttempts: number;
  readonly quota: UsageQuotaStatus;
}

export class UsageQuotaExceededError extends Error {
  readonly code: UsageQuotaExceededErrorCode = 'quota_exceeded';

  constructor(message = 'Monthly message quota exceeded.') {
    super(message);
    this.name = 'UsageQuotaExceededError';
  }
}

export function usageMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function getUsageSummary(storage: PosthornStorage, appId: string, now = new Date()): UsageSummary | null {
  const month = usageMonth(now);
  const app = getAppQuota(storage, appId);
  if (app === null) return null;

  const row = storage.db
    .prepare(
      `
        SELECT messages_accepted, delivery_attempts
        FROM usage_months
        WHERE app_id = ? AND month = ?
        LIMIT 1
      `,
    )
    .get(appId, month) as UsageMonthRow | undefined;

  const messagesAccepted = row === undefined ? 0 : Number(row.messages_accepted);
  const deliveryAttempts = row === undefined ? 0 : Number(row.delivery_attempts);
  return {
    appId,
    month,
    messagesAccepted,
    deliveryAttempts,
    quota: quotaStatus(app.monthlyMessageQuota, messagesAccepted),
  };
}

export function assertMessageQuotaAvailable(storage: PosthornStorage, appId: string, now = new Date()): void {
  const summary = getUsageSummary(storage, appId, now);
  if (summary === null) {
    throw new Error('App could not be found for usage quota check.');
  }
  if (summary.quota.exceeded) {
    throw new UsageQuotaExceededError();
  }
}

export function incrementAcceptedMessages(
  storage: PosthornStorage,
  appId: string,
  now = new Date(),
  amount = 1,
): void {
  incrementUsageCounters(storage, appId, usageMonth(now), amount, 0, now.toISOString());
}

export function incrementDeliveryAttemptsForDelivery(
  storage: PosthornStorage,
  deliveryId: string,
  now = new Date(),
  amount = 1,
): void {
  const row = storage.db
    .prepare(
      `
        SELECT messages.app_id
        FROM deliveries
        INNER JOIN messages ON messages.id = deliveries.message_id
        WHERE deliveries.id = ?
        LIMIT 1
      `,
    )
    .get(deliveryId) as DeliveryAppRow | undefined;

  if (row === undefined) {
    throw new Error('Delivery could not be found for usage metering.');
  }

  incrementUsageCounters(storage, String(row.app_id), usageMonth(now), 0, amount, now.toISOString());
}

function incrementUsageCounters(
  storage: PosthornStorage,
  appId: string,
  month: string,
  messagesAccepted: number,
  deliveryAttempts: number,
  updatedAt: string,
): void {
  storage.db
    .prepare(
      `
        INSERT INTO usage_months (app_id, month, messages_accepted, delivery_attempts, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(app_id, month) DO UPDATE SET
          messages_accepted = messages_accepted + excluded.messages_accepted,
          delivery_attempts = delivery_attempts + excluded.delivery_attempts,
          updated_at = excluded.updated_at
      `,
    )
    .run(appId, month, messagesAccepted, deliveryAttempts, updatedAt);
}

function getAppQuota(storage: PosthornStorage, appId: string): AppQuota | null {
  const row = storage.db
    .prepare(
      `
        SELECT monthly_message_quota
        FROM apps
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(appId) as AppQuotaRow | undefined;

  if (row === undefined) return null;
  return {
    monthlyMessageQuota:
      row.monthly_message_quota === null || row.monthly_message_quota === undefined
        ? null
        : Number(row.monthly_message_quota),
  };
}

function quotaStatus(monthlyMessageQuota: number | null, messagesAccepted: number): UsageQuotaStatus {
  if (monthlyMessageQuota === null) {
    return {
      monthlyMessageQuota,
      remaining: null,
      exceeded: false,
    };
  }

  return {
    monthlyMessageQuota,
    remaining: Math.max(0, monthlyMessageQuota - messagesAccepted),
    exceeded: messagesAccepted >= monthlyMessageQuota,
  };
}

interface AppQuota {
  readonly monthlyMessageQuota: number | null;
}

interface AppQuotaRow {
  readonly monthly_message_quota: unknown;
}

interface UsageMonthRow {
  readonly messages_accepted: unknown;
  readonly delivery_attempts: unknown;
}

interface DeliveryAppRow {
  readonly app_id: unknown;
}
