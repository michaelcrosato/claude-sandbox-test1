/**
 * Retry scheduling for webhook delivery.
 *
 * A {@link RetryPolicy} is fully described by an ordered list of delays (in
 * milliseconds) to wait between consecutive delivery attempts. The first
 * attempt fires immediately; `delaysMs[i]` is the wait after the `(i+1)`-th
 * attempt fails, before the `(i+2)`-th attempt is made. Once every delay has
 * been consumed the message is exhausted (dead-lettered).
 *
 * Everything here is pure and deterministic. Jitter is opt-in and takes an
 * injectable RNG so that scheduling stays fully reproducible under test.
 */

/** Default delay before the first retry when building exponential backoff. */
const DEFAULT_BASE_MS = 5_000;
/** Default growth factor for exponential backoff. */
const DEFAULT_FACTOR = 2;
/** Default per-delay ceiling for exponential backoff (12 hours). */
const DEFAULT_MAX_DELAY_MS = 12 * 60 * 60 * 1_000;

/**
 * An immutable retry schedule: the ordered waits between attempts.
 *
 * `delaysMs.length` is the number of retries; the total number of delivery
 * attempts is therefore `delaysMs.length + 1` (see {@link maxAttempts}).
 */
export interface RetryPolicy {
  /** Ordered delays (ms) between attempts. Length === number of retries. */
  readonly delaysMs: readonly number[];
  /**
   * HTTP status codes that bypass the retry schedule and immediately
   * dead-letter the delivery. Useful for 4xx responses (e.g. 400, 401, 410)
   * where retrying cannot change the outcome — the receiver has rejected the
   * request on a permanent basis. Absent or empty means "retry on any failure".
   */
  readonly nonRetryableStatuses?: readonly number[];
}

/**
 * Returns `true` when `status` should skip the retry schedule and immediately
 * dead-letter, according to `policy.nonRetryableStatuses`.
 */
export function isNonRetryableStatus(policy: RetryPolicy, status: number): boolean {
  return policy.nonRetryableStatuses?.includes(status) ?? false;
}

/** Options controlling jitter applied to a scheduled delay. */
export interface JitterOptions {
  /**
   * Symmetric jitter as a fraction of the base delay, in `[0, 1]`. A delay `d`
   * is spread uniformly across `[d * (1 - ratio), d * (1 + ratio)]`. Defaults
   * to `0` (no jitter). Values are clamped into range.
   */
  jitterRatio?: number;
  /**
   * RNG returning a value in `[0, 1)`. Defaults to `Math.random`. Inject a
   * deterministic source in tests to make scheduling reproducible.
   */
  random?: () => number;
}

/** The outcome of asking a policy what to do after an attempt resolves. */
export interface RetryPlan {
  /** Whether another attempt should be scheduled. */
  retry: boolean;
  /** 1-based index of the upcoming attempt. Present iff `retry` is `true`. */
  attempt?: number;
  /** Epoch-ms at which the upcoming attempt is eligible. Present iff `retry`. */
  nextAttemptAt?: number;
  /** The (possibly jittered) delay applied, in ms. Present iff `retry`. */
  delayMs?: number;
}

/** Total delivery attempts a policy permits (initial attempt + one per delay). */
export function maxAttempts(policy: RetryPolicy): number {
  return policy.delaysMs.length + 1;
}

/**
 * Build a policy from an explicit list of inter-attempt delays (ms).
 * Each delay must be a finite, non-negative number.
 */
export function fixedSchedule(delaysMs: readonly number[]): RetryPolicy {
  for (const delay of delaysMs) {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError(
        "retry delays must be finite, non-negative millisecond values",
      );
    }
  }
  return { delaysMs: Object.freeze([...delaysMs]) };
}

/** Options for {@link exponentialBackoff}. */
export interface ExponentialBackoffOptions {
  /** Number of retries to generate (delays produced). Non-negative integer. */
  retries: number;
  /** Delay before the first retry, in ms. Must be > 0. Defaults to 5000. */
  baseMs?: number;
  /** Geometric growth factor between retries. Must be >= 1. Defaults to 2. */
  factor?: number;
  /** Upper bound applied to every delay, in ms. Must be > 0. Defaults to 12h. */
  maxDelayMs?: number;
}

/**
 * Build a policy whose delays grow geometrically: `baseMs * factor^i`, each
 * capped at `maxDelayMs` and rounded to the nearest millisecond.
 */
export function exponentialBackoff(
  options: ExponentialBackoffOptions,
): RetryPolicy {
  const {
    retries,
    baseMs = DEFAULT_BASE_MS,
    factor = DEFAULT_FACTOR,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
  } = options;

  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError("retries must be a non-negative integer");
  }
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new RangeError("baseMs must be a positive, finite number");
  }
  if (!Number.isFinite(factor) || factor < 1) {
    throw new RangeError("factor must be a finite number >= 1");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    throw new RangeError("maxDelayMs must be a positive, finite number");
  }

  const delaysMs: number[] = [];
  for (let i = 0; i < retries; i++) {
    const raw = baseMs * Math.pow(factor, i);
    delaysMs.push(Math.min(Math.round(raw), maxDelayMs));
  }
  return { delaysMs: Object.freeze(delaysMs) };
}

/**
 * The default production schedule: 7 retries (8 total attempts) spread over
 * ~28 hours — 5s, 5m, 30m, 2h, 5h, 10h, 10h. Mirrors the schedule consumers
 * expect from established providers, giving transient receiver outages ample
 * time to recover before a message is dead-lettered.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = fixedSchedule([
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  5 * 60 * 60_000,
  10 * 60 * 60_000,
  10 * 60 * 60_000,
]);

/** Apply symmetric jitter to a delay using an injectable RNG. */
function jitter(delayMs: number, ratio: number, random: () => number): number {
  if (ratio <= 0 || delayMs === 0) {
    return delayMs;
  }
  const bounded = Math.min(ratio, 1);
  // random() in [0,1) -> scale in [1 - bounded, 1 + bounded).
  const scale = 1 + (random() * 2 - 1) * bounded;
  return Math.max(0, Math.round(delayMs * scale));
}

/**
 * Decide what happens after `attemptsMade` attempts have all failed.
 *
 * @param policy        the schedule to consult.
 * @param attemptsMade  count of attempts already made (each having failed);
 *                      must be a positive integer (>= 1).
 * @param nowMs         current time, epoch ms; the basis for `nextAttemptAt`.
 * @param options       optional jitter configuration.
 * @returns a {@link RetryPlan}: either a scheduled next attempt, or
 *          `{ retry: false }` when the schedule is exhausted (dead-letter).
 */
export function planNextAttempt(
  policy: RetryPolicy,
  attemptsMade: number,
  nowMs: number,
  options: JitterOptions = {},
): RetryPlan {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new RangeError("attemptsMade must be a positive integer");
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite number");
  }

  // The delay that follows the `attemptsMade`-th attempt lives at that index.
  const baseDelay = policy.delaysMs[attemptsMade - 1];
  if (baseDelay === undefined) {
    return { retry: false };
  }

  const ratio = options.jitterRatio ?? 0;
  const random = options.random ?? Math.random;
  const delayMs = jitter(baseDelay, ratio, random);

  return {
    retry: true,
    attempt: attemptsMade + 1,
    nextAttemptAt: nowMs + delayMs,
    delayMs,
  };
}
