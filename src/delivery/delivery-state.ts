/**
 * The delivery state machine.
 *
 * Tracks a single message's progress through delivery as a small, pure finite
 * state machine. The worker that actually performs HTTP calls owns I/O and
 * timing; this module owns the *decisions* — when to start an attempt, what a
 * success or failure means, and (via the {@link RetryPolicy}) when retries are
 * exhausted and the message must be dead-lettered.
 *
 * ```text
 *   pending ──attemptStarted──▶ delivering ──attemptSucceeded──▶ succeeded (terminal)
 *      │                            │
 *      │cancel                      └──attemptFailed──▶ dead_letter (terminal, exhausted)
 *      ▼                            └──── retry scheduled ◀────────────────────┐
 *   cancelled (terminal)                                                        │
 *      ▲                                                                        │
 *      └──────────────────────── manualRetry ◀─── (from any terminal state) ───┘
 * ```
 *
 * `cancel` moves a `pending` delivery to the terminal `cancelled` state — the
 * operator's abort path for a scheduled or queued delivery that should not be sent.
 *
 * `manualRetry` is the lone transition *out of* any terminal state — the operator's
 * recovery path. It revives a finished delivery as a brand-new one (a fresh
 * attempt budget, deliverable now), so a `dead_letter` whose receiver has since
 * been fixed can be replayed instead of being a permanent dead end.
 *
 * The reducer is deterministic: every transition is a pure function of the
 * current state, the event, the policy, and an injected clock/RNG. Illegal
 * transitions throw {@link DeliveryStateError} rather than silently no-op'ing,
 * so worker bugs surface immediately.
 */

import {
  type JitterOptions,
  type RetryPolicy,
  planNextAttempt,
} from "./retry-policy.js";

/**
 * - `pending`: awaiting an attempt (the first, or a scheduled retry). When
 *   awaiting a retry, {@link DeliveryState.nextAttemptAt} gives its eligibility.
 * - `delivering`: an attempt is in flight.
 * - `succeeded`: terminal — a delivery attempt got an accepting response.
 * - `dead_letter`: terminal — retries were exhausted without success.
 * - `cancelled`: terminal — the operator aborted the delivery before any attempt
 *   was made (or while it was queued for a retry). The `manualRetry` transition
 *   can revive a cancelled delivery the same way it revives a `dead_letter`.
 */
export type DeliveryStatus =
  | "pending"
  | "delivering"
  | "succeeded"
  | "dead_letter"
  | "cancelled";

/** An immutable snapshot of a message's delivery progress. */
export interface DeliveryState {
  readonly status: DeliveryStatus;
  /** Count of attempts that have been started so far. */
  readonly attempts: number;
  /**
   * Epoch-ms at which the next attempt becomes eligible while `pending`
   * awaiting a retry. `null` means "deliverable immediately" or "not pending".
   */
  readonly nextAttemptAt: number | null;
  /** Detail of the most recent failure, if any. */
  readonly lastError: string | null;
}

/** Events that drive the delivery state machine. */
export type DeliveryEvent =
  | { readonly type: "attemptStarted" }
  | { readonly type: "attemptSucceeded" }
  | { readonly type: "attemptFailed"; readonly error: string; readonly nowMs: number }
  | { readonly type: "manualRetry" }
  | { readonly type: "cancel" };

/** Thrown when an event is applied to a state that does not permit it. */
export class DeliveryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryStateError";
  }
}

/**
 * The starting state for a freshly created message.
 *
 * @param nextAttemptAt epoch-ms the first attempt is eligible; omit (or `null`)
 *                      to make it deliverable immediately.
 */
export function initialDeliveryState(
  nextAttemptAt: number | null = null,
): DeliveryState {
  return {
    status: "pending",
    attempts: 0,
    nextAttemptAt,
    lastError: null,
  };
}

/** Whether a state is terminal (no further transitions are possible). */
export function isTerminal(state: DeliveryState): boolean {
  return (
    state.status === "succeeded" ||
    state.status === "dead_letter" ||
    state.status === "cancelled"
  );
}

/**
 * Whether a message is eligible to be dispatched right now: it is `pending` and
 * either has no scheduled time or that time has arrived.
 */
export function isDeliverable(state: DeliveryState, nowMs: number): boolean {
  return (
    state.status === "pending" &&
    (state.nextAttemptAt === null || state.nextAttemptAt <= nowMs)
  );
}

function illegal(event: DeliveryEvent, state: DeliveryState): never {
  throw new DeliveryStateError(
    `cannot apply "${event.type}" while delivery is "${state.status}"`,
  );
}

/**
 * Apply an event to a delivery state, returning the next state.
 *
 * Pure and deterministic: failures consult `policy` through
 * {@link planNextAttempt}, using `event.nowMs` and the optional injected jitter
 * RNG. Throws {@link DeliveryStateError} on an illegal transition.
 */
export function reduce(
  policy: RetryPolicy,
  state: DeliveryState,
  event: DeliveryEvent,
  options: JitterOptions = {},
): DeliveryState {
  switch (event.type) {
    case "attemptStarted": {
      if (state.status !== "pending") {
        illegal(event, state);
      }
      return {
        status: "delivering",
        attempts: state.attempts + 1,
        nextAttemptAt: null,
        lastError: state.lastError,
      };
    }

    case "attemptSucceeded": {
      if (state.status !== "delivering") {
        illegal(event, state);
      }
      return {
        status: "succeeded",
        attempts: state.attempts,
        nextAttemptAt: null,
        lastError: state.lastError,
      };
    }

    case "attemptFailed": {
      if (state.status !== "delivering") {
        illegal(event, state);
      }
      const plan = planNextAttempt(policy, state.attempts, event.nowMs, options);
      if (plan.retry) {
        return {
          status: "pending",
          attempts: state.attempts,
          nextAttemptAt: plan.nextAttemptAt ?? event.nowMs,
          lastError: event.error,
        };
      }
      return {
        status: "dead_letter",
        attempts: state.attempts,
        nextAttemptAt: null,
        lastError: event.error,
      };
    }

    case "manualRetry": {
      // The only transition out of a terminal state. A non-terminal delivery is
      // already being driven (a pending retry is scheduled; a delivering attempt
      // is in flight), so there is nothing to manually revive — reject it.
      if (!isTerminal(state)) {
        illegal(event, state);
      }
      // Revive as a brand-new delivery: deliverable immediately and with the
      // attempt budget reset, so the *full* retry schedule applies again (a
      // dead-lettered delivery whose count was exhausted would otherwise re-fail
      // and re-dead-letter on its first new attempt). The prior `lastError` is
      // cleared — a clean slate. (Full per-attempt history is a later audit-log
      // add-on; this counter only feeds the retry policy.)
      return {
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      };
    }

    case "cancel": {
      // Only valid from `pending` — a delivery that is already in flight
      // (`delivering`) cannot be aborted mid-HTTP, and terminal deliveries
      // have nothing left to cancel.
      if (state.status !== "pending") {
        illegal(event, state);
      }
      return {
        status: "cancelled",
        attempts: state.attempts,
        nextAttemptAt: null,
        lastError: state.lastError,
      };
    }
  }
}
