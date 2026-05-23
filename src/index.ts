/**
 * Posthorn — open-core, Standard Webhooks-compliant reliable webhook delivery.
 *
 * Public entrypoint. As the delivery core, persistence, and HTTP API land
 * (see docs/PROJECT.md), their stable surfaces are re-exported here.
 */
export {
  sign,
  verify,
  generateSecret,
  WebhookVerificationError,
  HEADERS,
  type SignInput,
  type VerifyHeaders,
  type VerifyOptions,
} from "./signing/webhook-signature.js";

export {
  DEFAULT_RETRY_POLICY,
  exponentialBackoff,
  fixedSchedule,
  maxAttempts,
  planNextAttempt,
  type RetryPolicy,
  type RetryPlan,
  type JitterOptions,
  type ExponentialBackoffOptions,
} from "./delivery/retry-policy.js";

export {
  reduce,
  initialDeliveryState,
  isTerminal,
  isDeliverable,
  DeliveryStateError,
  type DeliveryState,
  type DeliveryStatus,
  type DeliveryEvent,
} from "./delivery/delivery-state.js";

export {
  IdempotencyConflictError,
  messageFingerprint,
  createMessageId,
  type Message,
  type NewMessage,
  type CreateMessageResult,
  type MessageStore,
} from "./storage/message-store.js";

export {
  InMemoryMessageStore,
  type InMemoryStoreOptions,
} from "./storage/in-memory-store.js";

export {
  SqliteMessageStore,
  type SqliteStoreOptions,
} from "./storage/sqlite-store.js";

export {
  UnknownDeliveryTaskError,
  StaleLeaseError,
  createTaskId,
  createLeaseToken,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  DEFAULT_CLAIM_LIMIT,
  type DeliveryQueue,
  type DeliveryTask,
  type EnqueueInput,
  type ClaimOptions,
  type FailInput,
} from "./queue/delivery-queue.js";

export {
  InMemoryDeliveryQueue,
  type InMemoryQueueOptions,
} from "./queue/in-memory-queue.js";

export {
  SqliteDeliveryQueue,
  type SqliteQueueOptions,
} from "./queue/sqlite-queue.js";

export {
  DeliveryWorker,
  buildSignedRequest,
  isSuccessStatus,
  fetchTransport,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_WORKER_BATCH_SIZE,
  type DeliveryWorkerOptions,
  type DeliveryTarget,
  type EndpointResolver,
  type Transport,
  type HttpDeliveryRequest,
  type HttpDeliveryResponse,
  type TickResult,
  type TaskOutcome,
} from "./worker/delivery-worker.js";
