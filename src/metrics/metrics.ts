/**
 * Operational metrics — Posthorn's operator-facing observability surface.
 *
 * The product promise is "signed, retried, **observable** webhooks." The
 * delivery-status read API (`GET /v1/messages/:id`) answers a *producer's*
 * question — "what happened to my webhook?" — but a self-hoster running the box
 * has a different one: "is the instance healthy, and how much is it doing?" This
 * module answers it in the format the self-host world standardised on: Prometheus
 * text exposition, scraped from an unauthenticated `GET /metrics`.
 *
 * Faithful to the codebase's pure-core / thin-I/O split. {@link MetricsRegistry}
 * is a tiny in-memory accumulator of monotonic counters, fed by two seams that
 * already exist — the ingest route and the delivery worker's per-tick tally
 * ({@link TickResult}) — and holds no domain logic of its own. {@link renderPrometheus}
 * is a **pure** function from a {@link MetricsSnapshot} to exposition text, so the
 * exact wire format is unit-tested without a clock, a store, or a socket. The
 * point-in-time gauges (the delivery backlog by status) are read from the queue at
 * scrape time and merged into the snapshot by the route — never cached here.
 *
 * Counters are process-lifetime and reset on restart. That is correct for the
 * single-process / single-container deployment model (no Redis, no shared counter
 * store), and Prometheus detects counter resets natively. A multi-replica hosted
 * plane (P5) would aggregate the per-instance series the usual way.
 *
 * ## Why unauthenticated
 *
 * `/metrics` exposes only instance-aggregate operational data — counts and a
 * backlog gauge — never a tenant id, payload, or secret, so it is safe to scrape
 * without a key, matching Prometheus norms. Operators who want it private should
 * restrict it at the network layer (a separate scrape network, or a reverse-proxy
 * allowlist); a dedicated admin port / opt-out flag is a reasonable later add.
 */

import type { TickResult } from "../worker/delivery-worker.js";
import type { DeliveryCountsByStatus } from "../queue/delivery-queue.js";
import {
  DELIVERY_FAILURE_REASONS,
  emptyDeliveryFailureCounts,
  type DeliveryFailureReasonCounts,
} from "../delivery/failure-reason.js";

/** `Content-Type` for Prometheus text exposition format, version 0.0.4. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Worker-settled delivery attempts by outcome (mirrors {@link TickResult}'s tallies). */
export interface DeliveryOutcomeCounts {
  /** Attempts that got a 2xx and were marked `succeeded`. */
  readonly succeeded: number;
  /** Failed attempts rescheduled for a future retry (`pending`). */
  readonly failed: number;
  /** Failed attempts whose retry budget was exhausted (`dead_letter`). */
  readonly deadLettered: number;
  /** Settles abandoned because the lease had lapsed and been reclaimed. */
  readonly stale: number;
}

/** Monotonic counters accumulated over the process lifetime. */
export interface MetricsCounters {
  /** Messages accepted by the ingest API (`POST /v1/messages`), including dedup replays. */
  readonly messagesIngested: number;
  /** Of those, accepted as an idempotent replay of an existing key. */
  readonly messagesDeduplicated: number;
  /** Delivery attempts the worker settled, broken down by outcome. */
  readonly deliveries: DeliveryOutcomeCounts;
  /**
   * Failed delivery attempts broken down by *reason* — the "why" behind the
   * `failed`+`dead_lettered` outcomes (unreachable vs. slow vs. 5xx vs. refused …).
   * Summed across reasons this equals `deliveries.failed + deliveries.deadLettered`.
   */
  readonly deliveryFailures: DeliveryFailureReasonCounts;
}

/** Everything {@link renderPrometheus} needs: counters + live gauges + metadata. */
export interface MetricsSnapshot {
  /** Build version, surfaced as the `posthorn_build_info` label. */
  readonly version: string;
  /** Seconds since the process started (the `posthorn_uptime_seconds` gauge). */
  readonly uptimeSeconds: number;
  /** Monotonic process-lifetime counters. */
  readonly counters: MetricsCounters;
  /** Point-in-time count of delivery tasks by status, read from the queue at scrape time. */
  readonly deliveryTasksByStatus: DeliveryCountsByStatus;
  /**
   * Point-in-time count of tasks currently in `dead_letter`, broken down by failure
   * *reason* — the actionable refinement of {@link deliveryTasksByStatus}'s single
   * `dead_letter` total ("*why* are deliveries permanently failing right now?"). Read
   * from the queue at scrape time; summed across reasons it equals that total.
   */
  readonly deadLettersByReason: DeliveryFailureReasonCounts;
}

/** Construction options for {@link MetricsRegistry}. */
export interface MetricsRegistryOptions {
  /** Build version reported by `posthorn_build_info`. Defaults to `"unknown"`. */
  readonly version?: string;
  /** Clock returning epoch ms (basis for uptime). Defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/**
 * An in-memory accumulator of Posthorn's monotonic operational counters.
 *
 * Construct one per running instance, feed it from the ingest route
 * ({@link MetricsRegistry.recordIngest}) and the delivery worker
 * ({@link MetricsRegistry.recordTick}), and read a {@link MetricsCounters}
 * snapshot at scrape time. It deliberately holds *only* counters + the start
 * instant; live gauges are read from the queue by the metrics route and merged in
 * there, so this class never reaches into a store.
 */
export class MetricsRegistry {
  /** Build version reported in `posthorn_build_info`. */
  readonly version: string;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  #messagesIngested = 0;
  #messagesDeduplicated = 0;
  #succeeded = 0;
  #failed = 0;
  #deadLettered = 0;
  #stale = 0;
  readonly #deliveryFailures = emptyDeliveryFailureCounts();

  constructor(options: MetricsRegistryOptions = {}) {
    this.version = options.version ?? "unknown";
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = this.#now();
  }

  /**
   * Record an accepted message. Arrow-bound so it can be passed directly as a
   * callback (e.g. from the ingest route) without losing `this`.
   */
  recordIngest = (event: { readonly deduplicated: boolean }): void => {
    this.#messagesIngested += 1;
    if (event.deduplicated) {
      this.#messagesDeduplicated += 1;
    }
  };

  /**
   * Fold one delivery-worker tick's tally into the delivery counters. Arrow-bound
   * so it slots straight into {@link DeliveryWorkerOptions.onTick}.
   */
  recordTick = (result: TickResult): void => {
    this.#succeeded += result.succeeded;
    this.#failed += result.failed;
    this.#deadLettered += result.deadLettered;
    this.#stale += result.stale;
    for (const reason of DELIVERY_FAILURE_REASONS) {
      this.#deliveryFailures[reason] += result.failureReasons[reason];
    }
  };

  /** Seconds since this registry (≈ the process) started; never negative. */
  uptimeSeconds(): number {
    return Math.max(0, (this.#now() - this.#startedAtMs) / 1000);
  }

  /** A point-in-time snapshot of the monotonic counters. */
  counters(): MetricsCounters {
    return {
      messagesIngested: this.#messagesIngested,
      messagesDeduplicated: this.#messagesDeduplicated,
      deliveries: {
        succeeded: this.#succeeded,
        failed: this.#failed,
        deadLettered: this.#deadLettered,
        stale: this.#stale,
      },
      // A copy so the snapshot can never mutate the registry's live tally.
      deliveryFailures: { ...this.#deliveryFailures },
    };
  }
}

/** One exposition sample: an optional label set and a numeric value. */
interface Sample {
  readonly labels?: Readonly<Record<string, string>>;
  readonly value: number;
}

/** Escape a label value per the exposition format (`\`, `"`, and newlines). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Render a numeric value; non-finite values use Prometheus' `+Inf`/`-Inf`/`NaN`. */
function formatValue(value: number): string {
  if (Number.isFinite(value)) {
    return String(value);
  }
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return "NaN";
}

/** Render a label set as `{k="v",…}`, or the empty string when there are none. */
function renderLabels(labels?: Readonly<Record<string, string>>): string {
  if (labels === undefined) {
    return "";
  }
  const parts = Object.entries(labels).map(
    ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
  );
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

/** Render one metric family: its `# HELP`/`# TYPE` header lines, then its samples. */
function renderFamily(
  name: string,
  type: "counter" | "gauge",
  help: string,
  samples: readonly Sample[],
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    lines.push(`${name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
  }
  return lines.join("\n");
}

/**
 * Render a {@link MetricsSnapshot} as Prometheus text exposition (v0.0.4). Pure
 * and total: a fixed set of metric families, every label series always present
 * (zeros included), terminated by a trailing newline as the format requires.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const { counters, deliveryTasksByStatus: tasks, deadLettersByReason } = snapshot;
  const families = [
    renderFamily(
      "posthorn_build_info",
      "gauge",
      "Build metadata; the value is always 1.",
      [{ labels: { version: snapshot.version }, value: 1 }],
    ),
    renderFamily(
      "posthorn_uptime_seconds",
      "gauge",
      "Seconds since the process started.",
      [{ value: snapshot.uptimeSeconds }],
    ),
    renderFamily(
      "posthorn_messages_ingested_total",
      "counter",
      "Messages accepted by the ingest API, including idempotent replays.",
      [{ value: counters.messagesIngested }],
    ),
    renderFamily(
      "posthorn_messages_deduplicated_total",
      "counter",
      "Ingested messages that were idempotent replays of an existing key.",
      [{ value: counters.messagesDeduplicated }],
    ),
    renderFamily(
      "posthorn_deliveries_total",
      "counter",
      "Delivery attempts settled by the worker, by outcome.",
      [
        { labels: { outcome: "succeeded" }, value: counters.deliveries.succeeded },
        { labels: { outcome: "failed" }, value: counters.deliveries.failed },
        { labels: { outcome: "dead_lettered" }, value: counters.deliveries.deadLettered },
        { labels: { outcome: "stale" }, value: counters.deliveries.stale },
      ],
    ),
    renderFamily(
      "posthorn_delivery_failures_total",
      "counter",
      "Failed delivery attempts by reason (the why behind failed + dead_lettered).",
      DELIVERY_FAILURE_REASONS.map((reason) => ({
        labels: { reason },
        value: counters.deliveryFailures[reason],
      })),
    ),
    renderFamily(
      "posthorn_delivery_tasks",
      "gauge",
      "Delivery tasks by current status (point-in-time backlog).",
      [
        { labels: { status: "pending" }, value: tasks.pending },
        { labels: { status: "delivering" }, value: tasks.delivering },
        { labels: { status: "succeeded" }, value: tasks.succeeded },
        { labels: { status: "dead_letter" }, value: tasks.dead_letter },
      ],
    ),
    renderFamily(
      "posthorn_dead_letter_tasks",
      "gauge",
      "Tasks currently in dead_letter by failure reason (point-in-time; sums to the " +
        "dead_letter series of posthorn_delivery_tasks).",
      DELIVERY_FAILURE_REASONS.map((reason) => ({
        labels: { reason },
        value: deadLettersByReason[reason],
      })),
    ),
  ];
  return families.join("\n") + "\n";
}
