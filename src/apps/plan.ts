/**
 * The plan catalog: the named entitlement tiers the hosted control plane assigns to
 * tenants.
 *
 * A {@link PlanEntitlements} bundle generalizes what used to be a single per-tenant
 * knob (`App.monthlyMessageQuota`) into the three levers a webhook SaaS meters on:
 * the **monthly message quota** (ingest cap), the **retention window** (how long
 * delivered history is kept), and the **per-endpoint delivery rate limit** (the
 * default ceiling applied to the tenant's endpoints). {@link PLAN_CATALOG} pins
 * those values for the `free` / `pro` / `scale` tiers.
 *
 * ## Plan vs. the stored quota — why a plan is a *preset*, not a live lookup
 *
 * Assigning a plan **stamps** its `monthlyMessageQuota` onto the {@link
 * import("./app.js").App} (see `normalizeNewApp` / `applyAppUpdate`); the enforced
 * value is the column on the app, not a live read of this catalog. That keeps the
 * ingest hot path a single field read (no catalog join) and — deliberately — means
 * a later catalog change does not retroactively move every existing tenant's
 * ceiling: a tenant's limit is stable until its plan is (re)assigned or its quota is
 * set explicitly. An explicit `monthlyMessageQuota` on the same create/update wins
 * over the plan's value, so an operator can fine-tune a single tenant off-catalog.
 *
 * A plan of `null` means **custom / unmanaged** (the default for a freshly created
 * app): no preset is applied, entitlements are whatever was set directly, and the
 * default quota stays `null` (no limit) — the correct posture for a self-hosted,
 * single-tenant deployment, which is unmetered.
 *
 * Pure module: no I/O, no dependency on a store. The HTTP layer reads it to surface
 * a tenant's entitlements; the app normalizers read it to stamp the quota.
 */

/** The named plan tiers the hosted control plane offers. `null` (off-catalog) = custom. */
export type PlanId = "free" | "pro" | "scale";

/** Every plan id, in ascending-tier order. The single source for validation + docs. */
export const PLAN_IDS: readonly PlanId[] = ["free", "pro", "scale"];

/**
 * The metered allowances a plan grants a tenant. Each is a non-negative integer, or
 * `null` for "no limit" (matching {@link import("./app.js").App.monthlyMessageQuota}'s
 * convention). The catalog tiers below all use concrete numbers; `null` is reserved
 * for a custom/unmanaged tenant whose entitlements are unbounded.
 */
export interface PlanEntitlements {
  /**
   * Messages the tenant may accept per UTC calendar month. Stamped onto the app and
   * enforced by `POST /v1/messages` (`429 quota_exceeded` once reached). This is the
   * one entitlement actively enforced today (see the module docstring).
   */
  readonly monthlyMessageQuota: number | null;
  /**
   * How many days of delivered message/attempt history the tenant's plan retains —
   * the tenant-facing allowance a dashboard surfaces. Note: the running gateway's
   * pruning is governed by the instance-wide `POSTHORN_RETENTION_DAYS`; this is the
   * plan's declared window, not a per-tenant pruning override.
   */
  readonly retentionDays: number | null;
  /**
   * The default per-endpoint delivery rate (deliveries/minute) the plan grants the
   * tenant's endpoints — the same unit as a per-endpoint `rateLimit` and the
   * instance-wide `POSTHORN_DEFAULT_RATE_LIMIT`. The plan's declared ceiling; bounded
   * by `MAX_RATE_LIMIT`.
   */
  readonly rateLimitPerMinute: number | null;
}

/**
 * The entitlements for each tier. A coherent freemium ladder: `free` is a small
 * trial allowance, `pro` a production tier, `scale` a high-volume tier. Truly
 * unlimited usage is a custom (`null`) plan, not a catalog tier — the named tiers
 * are all concrete so metering and upgrade prompts have real numbers to show.
 */
export const PLAN_CATALOG: Record<PlanId, PlanEntitlements> = Object.freeze({
  free: Object.freeze({ monthlyMessageQuota: 1_000, retentionDays: 7, rateLimitPerMinute: 60 }),
  pro: Object.freeze({ monthlyMessageQuota: 100_000, retentionDays: 30, rateLimitPerMinute: 600 }),
  scale: Object.freeze({ monthlyMessageQuota: 5_000_000, retentionDays: 90, rateLimitPerMinute: 6_000 }),
}) as Record<PlanId, PlanEntitlements>;

/** Type guard: `true` only for one of the {@link PLAN_IDS}. */
export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

/**
 * Validate and normalize an optional plan value, collapsing absent/`null` to `null`
 * (custom / unmanaged — no catalog preset). A present value must be one of {@link
 * PLAN_IDS}; anything else throws {@link TypeError}. Shared by every backend so plan
 * intake cannot drift, mirroring `normalizeQuota`.
 */
export function normalizePlan(value: unknown): PlanId | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlanId(value)) {
    throw new TypeError(`plan must be one of ${PLAN_IDS.join(", ")} or null`);
  }
  return value;
}

/**
 * The entitlements of an assigned plan, or `null` for a custom/unmanaged (`null`)
 * plan. A frozen catalog entry is returned as-is (callers must not mutate it). Used
 * by the HTTP layer to surface a tenant's plan allowances.
 */
export function entitlementsForPlan(plan: PlanId | null): PlanEntitlements | null {
  return plan === null ? null : PLAN_CATALOG[plan];
}
