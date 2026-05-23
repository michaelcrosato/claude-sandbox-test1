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
