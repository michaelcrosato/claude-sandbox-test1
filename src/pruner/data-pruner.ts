/**
 * The data-retention pruner — the scheduled sweep that enforces POSTHORN_RETENTION_DAYS.
 *
 * {@link DataPruner.pruneOnce} runs one pass: it deletes delivery attempts,
 * terminal delivery tasks, and messages older than the configured cutoff in that
 * order (attempts → terminal tasks → messages), so no live task is orphaned
 * mid-sweep. {@link DataPruner.run}/{@link DataPruner.stop} wrap it in a
 * continuous hourly loop, matching {@link FanoutDispatcher}'s structural pattern.
 *
 * Pruning is optional — `retentionDays = 0` (the gateway default) disables it.
 * When enabled, `retentionDays >= 1` is required so the cutoff always lands at
 * least one full day in the past; the default retry schedule exhausts within
 * ~28 hours, so messages older than two days are safe to delete without
 * abandoning any in-flight delivery.
 */

import type { DeliveryAttemptStore } from "../attempts/delivery-attempt.js";
import type { DeliveryQueue } from "../queue/delivery-queue.js";
import type { MessageStore } from "../storage/message-store.js";

/**
 * Default interval between pruner sweeps: 1 hour.
 * Pruning is not time-sensitive — hourly is frequent enough for any
 * reasonable retention window.
 */
export const DEFAULT_PRUNER_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** Aggregate result of one {@link DataPruner.pruneOnce} pass. */
export interface PruneResult {
  /** Delivery attempts deleted (older than the cutoff). */
  readonly prunedAttempts: number;
  /** Terminal (succeeded/dead_letter) delivery tasks deleted (older than the cutoff). */
  readonly prunedTasks: number;
  /** Messages deleted (fanned-out, older than the cutoff). */
  readonly prunedMessages: number;
  /** Epoch-ms cutoff used for this sweep (`now - retentionDays * 24h`). */
  readonly cutoffMs: number;
}

/** Construction options for {@link DataPruner}. */
export interface DataPrunerOptions {
  /** The attempt audit log to prune. */
  readonly attempts: DeliveryAttemptStore;
  /** The delivery queue from which terminal tasks are pruned. */
  readonly queue: DeliveryQueue;
  /** The message store from which old messages are pruned. */
  readonly messages: MessageStore;
  /**
   * How many days of history to retain. Data older than this many days
   * (measured from `now()`) is deleted. Must be a positive integer >= 1.
   */
  readonly retentionDays: number;
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  readonly now?: () => number;
  /** Pause between sweeps in {@link DataPruner.run}. Defaults to {@link DEFAULT_PRUNER_SWEEP_INTERVAL_MS}. */
  readonly sweepIntervalMs?: number;
  /** Sleep used between sweeps. Injectable for tests. Defaults to a timer sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Observability hook for errors during {@link DataPruner.run}. Without a hook,
   * errors are swallowed. The loop continues regardless of the error.
   */
  readonly onError?: (error: unknown) => void;
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scheduled data-retention sweeper. Construct once, then either call
 * {@link pruneOnce} (the deterministic unit of work) or let {@link run} sweep
 * at the configured interval until {@link stop}.
 */
export class DataPruner {
  readonly #attempts: DeliveryAttemptStore;
  readonly #queue: DeliveryQueue;
  readonly #messages: MessageStore;
  readonly #retentionMs: number;
  readonly #now: () => number;
  readonly #sweepIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onError: ((error: unknown) => void) | undefined;

  #stopped = false;
  #running = false;

  constructor(options: DataPrunerOptions) {
    const {
      attempts,
      queue,
      messages,
      retentionDays,
      now = Date.now,
      sweepIntervalMs = DEFAULT_PRUNER_SWEEP_INTERVAL_MS,
      sleep = timerSleep,
    } = options;
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new RangeError("retentionDays must be a positive integer >= 1");
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs < 0) {
      throw new RangeError("sweepIntervalMs must be a non-negative, finite number");
    }
    this.#attempts = attempts;
    this.#queue = queue;
    this.#messages = messages;
    this.#retentionMs = retentionDays * 24 * 60 * 60 * 1_000;
    this.#now = now;
    this.#sweepIntervalMs = sweepIntervalMs;
    this.#sleep = sleep;
    this.#onError = options.onError;
  }

  /** Whether {@link run} is currently looping. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Run one pruning pass. Deletes in dependency-safe order:
   * 1. Old delivery attempts — no dependents.
   * 2. Terminal delivery tasks — no dependents.
   * 3. Old messages — safe once terminal tasks are removed.
   *
   * Returns a tally of what was deleted and the cutoff timestamp used.
   */
  async pruneOnce(): Promise<PruneResult> {
    const cutoffMs = this.#now() - this.#retentionMs;
    const prunedAttempts = await this.#attempts.pruneOldAttempts(cutoffMs);
    const prunedTasks = await this.#queue.pruneTerminalTasks(cutoffMs);
    const prunedMessages = await this.#messages.pruneMessages(cutoffMs);
    return { prunedAttempts, prunedTasks, prunedMessages, cutoffMs };
  }

  /**
   * Sweep continuously: prune once, sleep `sweepIntervalMs`, repeat until
   * {@link stop}. A sweep error is routed to `onError` and the loop continues.
   *
   * @throws if already running.
   */
  async run(): Promise<void> {
    if (this.#running) {
      throw new Error("DataPruner is already running");
    }
    this.#running = true;
    this.#stopped = false;
    try {
      while (!this.#stopped) {
        try {
          await this.pruneOnce();
        } catch (error) {
          this.#onError?.(error);
        }
        if (this.#stopped) break;
        await this.#sleep(this.#sweepIntervalMs);
      }
    } finally {
      this.#running = false;
    }
  }

  /** Request that {@link run} stop after the current sweep / sleep. */
  stop(): void {
    this.#stopped = true;
  }
}
