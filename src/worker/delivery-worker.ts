/**
 * The delivery worker — Posthorn's runtime I/O driver.
 *
 * P0–P2 built the *decisions* and *durable state* as pure, self-contained islands:
 * the signer ({@link sign}), the retry policy + delivery FSM, the message store,
 * and the lease-based {@link DeliveryQueue}. None of them performs I/O. This module
 * is the loop that joins them into an actual send: it claims due tasks from the
 * queue, loads each message from the store, signs it, POSTs it over an injectable
 * transport, and settles the task (`complete`/`fail`) so the queue's pure FSM can
 * reschedule a retry or dead-letter an exhausted delivery.
 *
 * Everything that touches the outside world is an injected seam — the clock, the
 * HTTP transport, the endpoint resolver, the idle sleep — so the entire worker is
 * deterministic and fake-clock-testable in-process. The default transport is a
 * thin wrapper over `fetch`; the default endpoint resolver does not exist (there
 * is no endpoint store until P3), so a resolver must be supplied. That resolver is
 * the exact plug-point where P3's endpoint/subscription store will connect.
 *
 * ## What is and isn't here
 *
 * Pure decision logic stays in P1/P2 — this worker holds *no* retry/backoff or
 * state-transition logic of its own; it only classifies an HTTP response as
 * success or failure and hands the verdict to the queue. A single tick is
 * evaluated at one clock instant (one `now()` reading drives the claim, the
 * signature timestamp, and the settle), which keeps ticks deterministic.
 *
 * Tasks in a claimed batch are delivered through a **bounded concurrency pool**
 * (`concurrency`, default {@link DEFAULT_WORKER_CONCURRENCY}): up to `concurrency`
 * sends are in flight at once, so one slow or timing-out receiver no longer blocks
 * the healthy deliveries queued behind it (head-of-line blocking). Each task settles
 * independently under its own lease, so concurrency needs no extra coordination, and
 * within a tick delivery order is insignificant — webhook delivery is unordered.
 * Keep `ceil(batchSize / concurrency) × requestTimeoutMs` comfortably below the
 * queue's visibility timeout so a batch settles before its leases lapse (concurrency
 * shortens this worst case by up to `concurrency×` versus sequential). Settling is
 * always safe regardless: if a lease lapsed mid-attempt and another worker reclaimed
 * the task, the settle raises {@link StaleLeaseError}, which the worker absorbs and
 * counts as `stale` (the orphaned result is discarded, per the queue contract).
 */

import {
  HEADERS,
  sign,
} from "../signing/webhook-signature.js";
import {
  type Message,
  type MessageStore,
} from "../storage/message-store.js";
import {
  DEFAULT_CLAIM_LIMIT,
  StaleLeaseError,
  UnknownDeliveryTaskError,
  type DeliveryQueue,
  type DeliveryTask,
} from "../queue/delivery-queue.js";
import type { NewDeliveryAttempt } from "../attempts/delivery-attempt.js";

/**
 * Where a task's message should be delivered, and the secret to sign it with.
 *
 * The queue carries only an opaque `messageId`; the URL and signing secret live
 * with the subscription/endpoint, which has no store until P3. An
 * {@link EndpointResolver} bridges that gap.
 */
export interface DeliveryTarget {
  /** Absolute destination URL the signed payload is POSTed to. */
  readonly url: string;
  /** The endpoint's primary signing secret (`whsec_…` or bare base64), per Standard Webhooks. */
  readonly secret: string;
  /**
   * Additional signing secrets to include alongside {@link DeliveryTarget.secret}
   * — typically secrets retired during a rotation that are still inside their
   * overlap window. The payload is signed with the primary secret **and** each of
   * these, producing a multi-token `webhook-signature` header, so a receiver that
   * has not yet switched to the new secret still verifies (zero-downtime rotation).
   * Omitted when there is no active overlap.
   */
  readonly additionalSecrets?: readonly string[];
  /**
   * Extra headers to merge into the request (e.g. a customer-defined header).
   * They cannot override the Standard Webhooks `webhook-*` signing headers, which
   * are always applied last.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Resolves the delivery target for a task. Returns `null` when no endpoint can be
 * resolved (e.g. the subscription was deleted); the worker treats that as a failed
 * attempt so the queue's policy decides whether to retry or dead-letter — no
 * out-of-band task cancellation is introduced in v1.
 *
 * This is the seam P3's endpoint store implements. May be sync or async.
 */
export type EndpointResolver = (
  task: DeliveryTask,
  message: Message,
) => DeliveryTarget | null | Promise<DeliveryTarget | null>;

/** A fully-prepared, signed HTTP request ready for a {@link Transport}. */
export interface HttpDeliveryRequest {
  readonly url: string;
  readonly method: "POST";
  /** Includes the Standard Webhooks `webhook-id`/`-timestamp`/`-signature` headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact message payload, byte-for-byte (what was signed). */
  readonly body: string;
}

/** The outcome of a {@link Transport} call. */
export interface HttpDeliveryResponse {
  /** HTTP status code. 2xx is a successful delivery; anything else is a failure. */
  readonly status: number;
}

/**
 * Performs the actual HTTP POST. Injectable so tests use a fake and production
 * uses {@link fetchTransport}. A transport reports a server response (any status)
 * by *returning* it; it signals a transport-level failure (DNS, refused
 * connection, timeout/abort) by *throwing*. The worker treats a throw, and any
 * non-2xx status, as a failed attempt.
 *
 * The `signal` aborts when the worker's per-attempt `requestTimeoutMs` elapses.
 */
export type Transport = (
  request: HttpDeliveryRequest,
  signal: AbortSignal,
) => Promise<HttpDeliveryResponse>;

/** Per-task result of a single tick, tallied into a {@link TickResult}. */
export type TaskOutcome =
  | "succeeded"
  | "failed"
  | "deadLettered"
  | "stale";

/** Aggregate result of one {@link DeliveryWorker.processOnce} tick. */
export interface TickResult {
  /** Tasks claimed from the queue this tick. */
  readonly claimed: number;
  /** Attempts that got a 2xx and were marked `succeeded`. */
  readonly succeeded: number;
  /** Failed attempts rescheduled for a future retry (`pending`). */
  readonly failed: number;
  /** Failed attempts whose retries were exhausted (`dead_letter`). */
  readonly deadLettered: number;
  /** Settles abandoned because the lease had lapsed and been reclaimed. */
  readonly stale: number;
}

/** Default per-attempt HTTP timeout: 10s. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Default pause between polls when a tick claims no work: 1s. */
export const DEFAULT_IDLE_POLL_MS = 1_000;

/**
 * Default tasks claimed per tick. The batch is delivered through a bounded
 * concurrency pool (see {@link DEFAULT_WORKER_CONCURRENCY}), so the worst-case
 * wall-clock to settle it is `ceil(batchSize / concurrency) × requestTimeoutMs`;
 * keep that below the queue's visibility timeout so leases do not lapse mid-batch.
 * (The queue's own claim ceiling is {@link DEFAULT_CLAIM_LIMIT}.)
 */
export const DEFAULT_WORKER_BATCH_SIZE = 16;

/**
 * Default maximum number of deliveries in flight at once within a tick. Greater
 * than one so a single slow/timing-out receiver does not stall the rest of the
 * batch (head-of-line blocking); bounded so a burst cannot open an unbounded number
 * of sockets at once. A value of `1` restores fully sequential delivery. Operators
 * tune it via `POSTHORN_WORKER_CONCURRENCY` for their receiver fleet's latency profile.
 */
export const DEFAULT_WORKER_CONCURRENCY = 8;

/** Whether an HTTP status denotes a successful delivery (2xx). */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Build the signed HTTP request for a message to a target, sent at `sentAtMs`.
 *
 * Pure: the Standard Webhooks signature is computed over `{id}.{timestamp}.
 * {payload}` with the target's secret. The `webhook-timestamp` is the *send* time
 * in unix seconds (for the receiver's replay window), not the message's creation
 * time. When the target carries {@link DeliveryTarget.additionalSecrets} (rotation
 * overlap), the payload is signed with the primary secret **and** each additional
 * one, joined into a single space-delimited `webhook-signature` header — the
 * Standard Webhooks multi-token form a verifier accepts a match on any of. Caller-
 * supplied `target.headers` are merged first so they can customize transport-level
 * headers, but the `webhook-*` headers are applied last and thus cannot be
 * clobbered. The output verifies against {@link verify} by construction.
 */
export function buildSignedRequest(
  message: Message,
  target: DeliveryTarget,
  sentAtMs: number,
): HttpDeliveryRequest {
  const timestamp = Math.floor(sentAtMs / 1000);
  const input = { id: message.id, timestamp, payload: message.payload };
  // One token per active secret (primary first), space-joined per Standard Webhooks.
  const signature = [target.secret, ...(target.additionalSecrets ?? [])]
    .map((secret) => sign(secret, input))
    .join(" ");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(target.headers ?? {}),
    [HEADERS.id]: message.id,
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.signature]: signature,
  };
  return { url: target.url, method: "POST", headers, body: message.payload };
}

/** A `fetch`-backed {@link Transport}. The default for production use. */
export const fetchTransport: Transport = async (request, signal) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    signal,
  });
  // Drain the body so the socket is released; the bytes are not needed here
  // (a per-attempt audit log capturing response detail is a later add-on).
  try {
    await response.text();
  } catch {
    // A drain failure must not mask the status we already have.
  }
  return { status: response.status };
};

/** Construction options for {@link DeliveryWorker}. */
export interface DeliveryWorkerOptions {
  /** The durable queue tasks are claimed from and settled against. */
  readonly queue: DeliveryQueue;
  /** The store messages are loaded from. */
  readonly store: MessageStore;
  /** Resolves a task+message to its destination URL and signing secret. */
  readonly resolveEndpoint: EndpointResolver;
  /** HTTP transport. Defaults to {@link fetchTransport}. */
  readonly transport?: Transport;
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  readonly now?: () => number;
  /** Tasks claimed per tick. Defaults to {@link DEFAULT_WORKER_BATCH_SIZE}. */
  readonly batchSize?: number;
  /**
   * Maximum deliveries in flight at once within a tick. Defaults to
   * {@link DEFAULT_WORKER_CONCURRENCY}. A value of `1` restores fully sequential
   * delivery. Effectively capped by the batch size at run time (never more than the
   * number of claimed tasks run at once).
   */
  readonly concurrency?: number;
  /** Per-attempt HTTP timeout in ms. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
  /** Pause between idle polls in {@link DeliveryWorker.run}. Defaults to {@link DEFAULT_IDLE_POLL_MS}. */
  readonly idlePollMs?: number;
  /** Sleep used between idle polls. Injectable for tests. Defaults to a timer sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Observability hook for an *unexpected* error during a tick (e.g. a backend
   * failure while settling — not the expected {@link StaleLeaseError}). In
   * {@link DeliveryWorker.run} the loop survives such errors by reporting them
   * here and backing off; without a hook they are swallowed. Defaults to a no-op.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Observability hook called once per completed {@link DeliveryWorker.processOnce}
   * tick with its tally. The seam the metrics registry feeds from
   * (`onTick: registry.recordTick`); it carries no decision logic. Not called on a
   * tick that throws (an unexpected settle error propagates instead). Defaults to a
   * no-op.
   */
  readonly onTick?: (result: TickResult) => void;
  /**
   * Audit-log seam: called once per delivery attempt with that attempt's outcome,
   * HTTP status, error, and latency — the data behind the per-attempt audit log
   * (`GET /v1/messages/:id/attempts`). The gateway wires this to a
   * {@link import("../attempts/delivery-attempt.js").DeliveryAttemptStore}'s
   * `record`. The worker holds no audit logic of its own; it only reports what
   * happened. Recording is **best-effort** — a thrown/rejected record is routed to
   * `onError` and never blocks or fails the delivery (the audit trail is an add-on,
   * delivery is the core). Omit to record nothing (the default).
   */
  readonly recordAttempt?: (attempt: NewDeliveryAttempt) => void | Promise<void>;
  /**
   * Endpoint-health seam: called once per *terminal* delivery outcome — a 2xx
   * `succeeded` or a retries-exhausted `failed` (dead-letter) — with the target
   * `endpointId`, the outcome, and the tick instant. The gateway wires this to
   * {@link import("../endpoints/endpoint.js").EndpointStore.recordDeliveryOutcome},
   * which folds the outcome into the endpoint's health and **auto-disables** an
   * endpoint that has been failing continuously — capping the delivery attempts (and
   * the tenant's metered operations) wasted on a permanently-dead endpoint. The worker
   * holds no health logic of its own; it only reports the terminal verdict.
   *
   * *Not* called for a retryable failed attempt (not yet terminal — the endpoint may
   * recover on retry), a `stale` settle (another worker's concern), or a task with no
   * `endpointId`. Best-effort, exactly like {@link recordAttempt}: a thrown/rejected
   * report is routed to `onError` and never blocks or fails the delivery (health is an
   * add-on; delivery is the core). Omit to track nothing (the default).
   */
  readonly onDeliveryOutcome?: (
    endpointId: string,
    outcome: "succeeded" | "failed",
    nowMs: number,
  ) => void | Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The runtime delivery loop. Construct once, then either drive it tick-by-tick
 * with {@link processOnce} (the unit of work) or let {@link run} poll it
 * continuously until {@link stop}.
 */
export class DeliveryWorker {
  readonly #queue: DeliveryQueue;
  readonly #store: MessageStore;
  readonly #resolveEndpoint: EndpointResolver;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #requestTimeoutMs: number;
  readonly #idlePollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onTick: ((result: TickResult) => void) | undefined;
  readonly #recordAttempt:
    | ((attempt: NewDeliveryAttempt) => void | Promise<void>)
    | undefined;
  readonly #onDeliveryOutcome:
    | ((
        endpointId: string,
        outcome: "succeeded" | "failed",
        nowMs: number,
      ) => void | Promise<void>)
    | undefined;

  #stopped = false;
  #running = false;

  constructor(options: DeliveryWorkerOptions) {
    const {
      queue,
      store,
      resolveEndpoint,
      transport = fetchTransport,
      now = Date.now,
      batchSize = DEFAULT_WORKER_BATCH_SIZE,
      concurrency = DEFAULT_WORKER_CONCURRENCY,
      requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      idlePollMs = DEFAULT_IDLE_POLL_MS,
      sleep = timerSleep,
    } = options;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive, finite number");
    }
    if (!Number.isFinite(idlePollMs) || idlePollMs < 0) {
      throw new RangeError("idlePollMs must be a non-negative, finite number");
    }
    this.#queue = queue;
    this.#store = store;
    this.#resolveEndpoint = resolveEndpoint;
    this.#transport = transport;
    this.#now = now;
    this.#batchSize = batchSize;
    this.#concurrency = concurrency;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#idlePollMs = idlePollMs;
    this.#sleep = sleep;
    this.#onError = options.onError;
    this.#onTick = options.onTick;
    this.#recordAttempt = options.recordAttempt;
    this.#onDeliveryOutcome = options.onDeliveryOutcome;
  }

  /** Whether {@link run} is currently looping. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Claim one batch of due tasks and deliver each, returning a tally. Evaluated
   * at a single `now()` instant. Expected lease-loss is absorbed (counted
   * `stale`); an unexpected settle error propagates so a direct caller sees it.
   */
  async processOnce(): Promise<TickResult> {
    const nowMs = this.#now();
    const tasks = await this.#queue.claimDue({
      nowMs,
      limit: this.#batchSize,
    });
    const outcomes = await this.#deliverBatch(tasks, nowMs);
    let succeeded = 0;
    let failed = 0;
    let deadLettered = 0;
    let stale = 0;
    for (const outcome of outcomes) {
      switch (outcome) {
        case "succeeded":
          succeeded += 1;
          break;
        case "failed":
          failed += 1;
          break;
        case "deadLettered":
          deadLettered += 1;
          break;
        case "stale":
          stale += 1;
          break;
      }
    }
    const result: TickResult = {
      claimed: tasks.length,
      succeeded,
      failed,
      deadLettered,
      stale,
    };
    this.#onTick?.(result);
    return result;
  }

  /**
   * Deliver a claimed batch through a bounded concurrency pool, returning each
   * task's outcome by its original index. At most `#concurrency` deliveries are in
   * flight at once: a fixed set of pump loops each pull the next un-started task as
   * they free up, so a slow receiver only occupies its own slot rather than blocking
   * the whole batch (head-of-line blocking). Each {@link #deliver} settles its own
   * task under its own lease, so the pumps need no further coordination.
   *
   * If a delivery raises an *unexpected* (non-stale) error, the pumps stop pulling
   * new work and the first such error is re-thrown once the already in-flight
   * deliveries settle — preserving {@link processOnce}'s "an unexpected settle error
   * propagates" contract while ensuring no sibling pump rejection goes unhandled.
   */
  async #deliverBatch(
    tasks: readonly DeliveryTask[],
    nowMs: number,
  ): Promise<TaskOutcome[]> {
    const outcomes = new Array<TaskOutcome>(tasks.length);
    let cursor = 0;
    let firstError: unknown = undefined;
    let failed = false;
    const pump = async (): Promise<void> => {
      while (cursor < tasks.length && !failed) {
        const index = cursor;
        cursor += 1;
        try {
          outcomes[index] = await this.#deliver(tasks[index]!, nowMs);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          return;
        }
      }
    };
    const poolSize = Math.min(this.#concurrency, tasks.length);
    const pumps: Promise<void>[] = [];
    for (let i = 0; i < poolSize; i += 1) {
      pumps.push(pump());
    }
    await Promise.all(pumps);
    if (failed) {
      throw firstError;
    }
    return outcomes;
  }

  /**
   * Poll continuously: drain claimable work back-to-back, sleeping `idlePollMs`
   * whenever a tick finds nothing. Resolves once {@link stop} is called (which
   * takes effect within one poll interval). Unexpected settle errors are routed
   * to `onError` and the loop continues — one bad task never halts the worker.
   *
   * @throws if already running.
   */
  async run(): Promise<void> {
    if (this.#running) {
      throw new Error("DeliveryWorker is already running");
    }
    this.#running = true;
    this.#stopped = false;
    try {
      while (!this.#stopped) {
        let claimed = 0;
        try {
          claimed = (await this.processOnce()).claimed;
        } catch (error) {
          // Resilience: a backend hiccup (e.g. a settle error) must not kill the
          // loop. Surface it and back off as if idle.
          this.#onError?.(error);
          claimed = 0;
        }
        if (this.#stopped) break;
        if (claimed === 0) {
          await this.#sleep(this.#idlePollMs);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Request that {@link run} stop after the current tick / poll interval. */
  stop(): void {
    this.#stopped = true;
  }

  /**
   * Deliver one claimed task end-to-end and settle it. Any error from loading,
   * resolving, signing, or transport is captured as a failed attempt — that is a
   * delivery failure, not a worker fault. Returns the task's outcome.
   */
  async #deliver(task: DeliveryTask, nowMs: number): Promise<TaskOutcome> {
    const leaseToken = task.leaseToken;
    if (leaseToken === null) {
      // A claimed task always holds a lease; defensively skip if not.
      return "stale";
    }

    let response: HttpDeliveryResponse | null = null;
    let failure: string | null = null;
    let durationMs = 0;
    // The tenant the attempt is made on behalf of, denormalized onto the audit record
    // (the basis for per-tenant delivery-usage metering). Null until the message loads;
    // it stays null for a vanished message, whose attempt belongs to no tenant.
    let appId: string | null = null;
    try {
      const message = await this.#store.get(task.messageId);
      if (message === null) {
        failure = `message "${task.messageId}" not found`;
      } else {
        appId = message.appId;
        const target = await this.#resolveEndpoint(task, message);
        if (target === null) {
          failure = `no endpoint resolved for task "${task.id}"`;
        } else {
          const sentAt = this.#now();
          try {
            response = await this.#send(buildSignedRequest(message, target, nowMs));
          } finally {
            // Capture latency even when #send throws — a timeout's duration is the
            // most useful number there is. Math.max guards a non-monotonic clock.
            durationMs = Math.max(0, this.#now() - sentAt);
          }
        }
      }
    } catch (error) {
      failure = describeError(error);
    }

    const succeeded = response !== null && isSuccessStatus(response.status);
    const error = succeeded
      ? null
      : failure ?? `endpoint returned HTTP ${String(response?.status)}`;

    // Append this attempt to the audit log before settling. Best-effort: a failed
    // record never changes the delivery outcome (see #recordDeliveryAttempt).
    await this.#recordDeliveryAttempt(task, nowMs, appId, {
      succeeded,
      responseStatus: response?.status ?? null,
      error,
      durationMs,
    });

    const outcome = succeeded
      ? await this.#settleSuccess(task, leaseToken)
      : await this.#settleFailure(
          task,
          leaseToken,
          error ?? "unknown delivery error",
          nowMs,
        );
    // Report the terminal verdict to endpoint-health tracking (best-effort).
    await this.#reportEndpointOutcome(task, outcome, nowMs);
    return outcome;
  }

  /**
   * Report a *terminal* delivery outcome to the endpoint-health seam, if wired — the
   * basis for automatically disabling an endpoint that has been failing continuously
   * (see {@link import("../endpoints/endpoint.js").evaluateEndpointHealth}). Only
   * `succeeded` (a 2xx) and `deadLettered` (retries exhausted) are terminal signals;
   * a `failed` attempt that will be retried is not yet evidence the endpoint is
   * unhealthy, and a `stale` settle belongs to whichever worker reclaimed the lease.
   * Skipped when the task carries no `endpointId`. Best-effort, exactly like
   * {@link #recordDeliveryAttempt}: a thrown/rejected report is routed to `onError`
   * and never changes the delivery outcome.
   */
  async #reportEndpointOutcome(
    task: DeliveryTask,
    outcome: TaskOutcome,
    nowMs: number,
  ): Promise<void> {
    const report = this.#onDeliveryOutcome;
    if (report === undefined || task.endpointId === null) {
      return;
    }
    if (outcome !== "succeeded" && outcome !== "deadLettered") {
      return;
    }
    try {
      await report(
        task.endpointId,
        outcome === "succeeded" ? "succeeded" : "failed",
        nowMs,
      );
    } catch (err) {
      this.#onError?.(err);
    }
  }

  /**
   * Append this attempt to the audit log via the injected `recordAttempt` seam, if
   * any. Best-effort by contract: a thrown/rejected record is routed to `onError`
   * and swallowed, so a flaky audit write never blocks or fails an otherwise-fine
   * delivery. The attempt's `attemptedAt` is the tick instant; its `attemptNumber`
   * is the claimed task's `attempts` (already incremented by `applyClaim`, so it is
   * this attempt's 1-based number); `appId` is the delivered message's tenant
   * (`null` if the message had vanished), denormalized so per-tenant delivery usage
   * is a single indexed scan.
   */
  async #recordDeliveryAttempt(
    task: DeliveryTask,
    attemptedAt: number,
    appId: string | null,
    detail: {
      readonly succeeded: boolean;
      readonly responseStatus: number | null;
      readonly error: string | null;
      readonly durationMs: number;
    },
  ): Promise<void> {
    const record = this.#recordAttempt;
    if (record === undefined) {
      return;
    }
    try {
      await record({
        taskId: task.id,
        messageId: task.messageId,
        appId,
        endpointId: task.endpointId,
        attemptNumber: task.attempts,
        outcome: detail.succeeded ? "succeeded" : "failed",
        responseStatus: detail.responseStatus,
        error: detail.error,
        durationMs: detail.durationMs,
        attemptedAt,
      });
    } catch (err) {
      this.#onError?.(err);
    }
  }

  /** Run the transport with a per-attempt timeout. */
  async #send(request: HttpDeliveryRequest): Promise<HttpDeliveryResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#requestTimeoutMs);
    try {
      return await this.#transport(request, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async #settleSuccess(
    task: DeliveryTask,
    leaseToken: string,
  ): Promise<TaskOutcome> {
    try {
      await this.#queue.complete(task.id, leaseToken);
      return "succeeded";
    } catch (error) {
      return this.#absorbSettleError(error, task);
    }
  }

  async #settleFailure(
    task: DeliveryTask,
    leaseToken: string,
    error: string,
    nowMs: number,
  ): Promise<TaskOutcome> {
    try {
      const settled = await this.#queue.fail(task.id, leaseToken, {
        error,
        nowMs,
      });
      return settled.status === "dead_letter" ? "deadLettered" : "failed";
    } catch (settleError) {
      return this.#absorbSettleError(settleError, task);
    }
  }

  /**
   * A {@link StaleLeaseError}/{@link UnknownDeliveryTaskError} on settle is the
   * expected at-least-once outcome of a lapsed-and-reclaimed lease: discard the
   * orphaned result (`stale`). Anything else is unexpected and re-thrown.
   */
  #absorbSettleError(error: unknown, task: DeliveryTask): TaskOutcome {
    if (
      error instanceof StaleLeaseError ||
      error instanceof UnknownDeliveryTaskError
    ) {
      return "stale";
    }
    throw error;
  }
}
