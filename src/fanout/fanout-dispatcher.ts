/**
 * The fan-out dispatcher — the relay half of Posthorn's transactional outbox.
 *
 * {@link ingest} accepts a message and records, atomically, that it owes a
 * fan-out (the `fanned_out_at` outbox marker in the message store). On the common
 * path ingest also fans the message out inline and clears the marker. But a crash
 * between accept and fan-out — or a producer that never retries a failed accept —
 * can leave a message *accepted but never fanned out*. This dispatcher is the
 * safety net that guarantees such a message is eventually fanned out: it polls
 * {@link MessageStore.listPendingFanout} for messages still owing a fan-out and
 * drains each one (list endpoints → enqueue deliveries → mark done).
 *
 * It is the structural twin of the {@link DeliveryWorker}: a deterministic unit
 * of work ({@link FanoutDispatcher.sweepOnce}) wrapped by a continuous poll loop
 * ({@link FanoutDispatcher.run}/{@link FanoutDispatcher.stop}), with every
 * outside-world touch (the clock, the idle sleep) injected so the whole thing is
 * fake-clock-testable in-process. It holds no routing logic of its own — it
 * reuses the pure {@link fanOut} — so the selection rules cannot drift.
 *
 * ## The grace period
 *
 * A healthy ingest clears its marker within milliseconds of accepting a message.
 * To avoid racing such an in-flight ingest (and double-enqueueing its fan-out),
 * the dispatcher only considers messages older than `graceMs`: it recovers
 * genuine orphans, not work that is about to complete on its own. A duplicate
 * fan-out is *safe* regardless — the queue is at-least-once and every message
 * carries a stable id for receiver-side dedup — so the grace period is an
 * efficiency guard, not a correctness one.
 */

import type { EndpointStore } from "../endpoints/endpoint.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import type { MessageStore } from "../storage/message-store.js";
import { fanOut } from "./fanout.js";

/**
 * Default grace period before an unfanned message is treated as an orphan: 30s.
 * Comfortably longer than a healthy inline fan-out, so the dispatcher never races
 * one.
 */
export const DEFAULT_FANOUT_GRACE_MS = 30_000;

/** Default messages drained per sweep. */
export const DEFAULT_FANOUT_BATCH_SIZE = 100;

/** Default pause between polls when a sweep makes no progress: 1s. */
export const DEFAULT_FANOUT_IDLE_POLL_MS = 1_000;

/** Aggregate result of one {@link FanoutDispatcher.sweepOnce}. */
export interface SweepResult {
  /** Pending messages picked up this sweep (subject to grace + batch size). */
  readonly pending: number;
  /** Messages fanned out and marked done this sweep. */
  readonly fannedOut: number;
  /** Messages whose fan-out threw and were left pending for a later sweep. */
  readonly failed: number;
}

/** Construction options for {@link FanoutDispatcher}. */
export interface FanoutDispatcherOptions {
  /** The outbox: where pending fan-outs are listed and marked done. */
  readonly messages: MessageStore;
  /** The subscriptions a message is fanned out across. */
  readonly endpoints: EndpointStore;
  /** Where the resulting delivery work is enqueued. */
  readonly queue: DeliveryQueue;
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  readonly now?: () => number;
  /**
   * How old (ms) a pending message must be before it is treated as an orphan and
   * swept. Defaults to {@link DEFAULT_FANOUT_GRACE_MS}. `0` sweeps immediately
   * (useful in tests, where there is no concurrent inline ingest to race).
   */
  readonly graceMs?: number;
  /** Messages drained per sweep. Defaults to {@link DEFAULT_FANOUT_BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Pause between idle polls in {@link FanoutDispatcher.run}. Defaults to {@link DEFAULT_FANOUT_IDLE_POLL_MS}. */
  readonly idlePollMs?: number;
  /** Sleep used between idle polls. Injectable for tests. Defaults to a timer sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Observability hook for an error while sweeping a message (a backend or queue
   * failure). The message is left pending so a later sweep retries it; the loop
   * survives. Without a hook such errors are swallowed. Defaults to a no-op.
   */
  readonly onError?: (error: unknown) => void;
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The outbox relay. Construct once, then either drive it sweep-by-sweep with
 * {@link sweepOnce} (the unit of work) or let {@link run} poll it continuously
 * until {@link stop}.
 */
export class FanoutDispatcher {
  readonly #messages: MessageStore;
  readonly #endpoints: EndpointStore;
  readonly #queue: DeliveryQueue;
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #batchSize: number;
  readonly #idlePollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onError: ((error: unknown) => void) | undefined;

  #stopped = false;
  #running = false;

  constructor(options: FanoutDispatcherOptions) {
    const {
      messages,
      endpoints,
      queue,
      now = Date.now,
      graceMs = DEFAULT_FANOUT_GRACE_MS,
      batchSize = DEFAULT_FANOUT_BATCH_SIZE,
      idlePollMs = DEFAULT_FANOUT_IDLE_POLL_MS,
      sleep = timerSleep,
    } = options;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new RangeError("graceMs must be a non-negative, finite number");
    }
    if (!Number.isFinite(idlePollMs) || idlePollMs < 0) {
      throw new RangeError("idlePollMs must be a non-negative, finite number");
    }
    this.#messages = messages;
    this.#endpoints = endpoints;
    this.#queue = queue;
    this.#now = now;
    this.#graceMs = graceMs;
    this.#batchSize = batchSize;
    this.#idlePollMs = idlePollMs;
    this.#sleep = sleep;
    this.#onError = options.onError;
  }

  /** Whether {@link run} is currently looping. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Drain one batch of orphaned pending fan-outs and return a tally. Evaluated at
   * a single `now()` instant. A per-message fan-out failure is isolated: it is
   * reported to `onError`, the message is left pending for a later sweep, and the
   * sweep proceeds to the next message.
   */
  async sweepOnce(): Promise<SweepResult> {
    const nowMs = this.#now();
    const pending = await this.#messages.listPendingFanout({
      limit: this.#batchSize,
      createdAtOrBefore: nowMs - this.#graceMs,
    });
    let fannedOut = 0;
    let failed = 0;
    for (const message of pending) {
      try {
        await fanOut(message, {
          endpoints: this.#endpoints,
          queue: this.#queue,
        });
        await this.#messages.markFannedOut(message.id);
        fannedOut += 1;
      } catch (error) {
        // Leave the marker set so the next sweep retries; never lose the message.
        this.#onError?.(error);
        failed += 1;
      }
    }
    return { pending: pending.length, fannedOut, failed };
  }

  /**
   * Poll continuously: drain orphans back-to-back, sleeping `idlePollMs` whenever
   * a sweep makes **no progress** (nothing pending, or every message failed —
   * which backs off rather than hot-looping on a persistent failure). Resolves
   * once {@link stop} is called. A failure listing the outbox is routed to
   * `onError` and the loop continues.
   *
   * @throws if already running.
   */
  async run(): Promise<void> {
    if (this.#running) {
      throw new Error("FanoutDispatcher is already running");
    }
    this.#running = true;
    this.#stopped = false;
    try {
      while (!this.#stopped) {
        let progressed = 0;
        try {
          progressed = (await this.sweepOnce()).fannedOut;
        } catch (error) {
          // Resilience: a backend hiccup must not kill the loop. Back off as idle.
          this.#onError?.(error);
          progressed = 0;
        }
        if (this.#stopped) break;
        if (progressed === 0) {
          await this.#sleep(this.#idlePollMs);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Request that {@link run} stop after the current sweep / poll interval. */
  stop(): void {
    this.#stopped = true;
  }
}
