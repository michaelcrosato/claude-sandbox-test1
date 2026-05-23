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
 * Tasks in a claimed batch are processed **sequentially** in v1: simple, ordered,
 * and trivially testable. Keep `batchSize × requestTimeoutMs` comfortably below
 * the queue's visibility timeout so a batch settles before its leases lapse;
 * bounded concurrency is the next throughput optimization. Settling is always
 * safe regardless: if a lease lapsed mid-attempt and another worker reclaimed the
 * task, the settle raises {@link StaleLeaseError}, which the worker absorbs and
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
  /** The endpoint's signing secret (`whsec_…` or bare base64), per Standard Webhooks. */
  readonly secret: string;
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
 * Default tasks claimed per tick. Modest because v1 processes a batch
 * sequentially: keep `batchSize × requestTimeoutMs` below the queue's visibility
 * timeout so leases do not lapse mid-batch. (The queue's own claim ceiling is
 * {@link DEFAULT_CLAIM_LIMIT}.)
 */
export const DEFAULT_WORKER_BATCH_SIZE = 16;

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
 * time. Caller-supplied `target.headers` are merged first so they can customize
 * transport-level headers, but the `webhook-*` headers are applied last and thus
 * cannot be clobbered. The output verifies against {@link verify} by construction.
 */
export function buildSignedRequest(
  message: Message,
  target: DeliveryTarget,
  sentAtMs: number,
): HttpDeliveryRequest {
  const timestamp = Math.floor(sentAtMs / 1000);
  const signature = sign(target.secret, {
    id: message.id,
    timestamp,
    payload: message.payload,
  });
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
  readonly #requestTimeoutMs: number;
  readonly #idlePollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onError: ((error: unknown) => void) | undefined;

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
      requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      idlePollMs = DEFAULT_IDLE_POLL_MS,
      sleep = timerSleep,
    } = options;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
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
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#idlePollMs = idlePollMs;
    this.#sleep = sleep;
    this.#onError = options.onError;
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
    let succeeded = 0;
    let failed = 0;
    let deadLettered = 0;
    let stale = 0;
    for (const task of tasks) {
      const outcome = await this.#deliver(task, nowMs);
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
    return { claimed: tasks.length, succeeded, failed, deadLettered, stale };
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
    try {
      const message = await this.#store.get(task.messageId);
      if (message === null) {
        failure = `message "${task.messageId}" not found`;
      } else {
        const target = await this.#resolveEndpoint(task, message);
        if (target === null) {
          failure = `no endpoint resolved for task "${task.id}"`;
        } else {
          response = await this.#send(buildSignedRequest(message, target, nowMs));
        }
      }
    } catch (error) {
      failure = describeError(error);
    }

    if (response !== null && isSuccessStatus(response.status)) {
      return this.#settleSuccess(task, leaseToken);
    }
    const error =
      failure ?? `endpoint returned HTTP ${String(response?.status)}`;
    return this.#settleFailure(task, leaseToken, error, nowMs);
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
