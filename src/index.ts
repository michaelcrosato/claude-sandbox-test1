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
  DEFAULT_PENDING_FANOUT_LIMIT,
  type Message,
  type NewMessage,
  type CreateMessageResult,
  type ListPendingFanoutOptions,
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

export {
  UnknownEndpointError,
  createEndpointId,
  endpointSubscribesTo,
  normalizeNewEndpoint,
  applyEndpointUpdate,
  type Endpoint,
  type NewEndpoint,
  type EndpointUpdate,
  type EndpointStore,
  type NormalizedNewEndpoint,
} from "./endpoints/endpoint.js";

export {
  InMemoryEndpointStore,
  type InMemoryEndpointStoreOptions,
} from "./endpoints/in-memory-endpoint-store.js";

export {
  SqliteEndpointStore,
  type SqliteEndpointStoreOptions,
} from "./endpoints/sqlite-endpoint-store.js";

export {
  storeBackedResolver,
  endpointToDeliveryTarget,
} from "./endpoints/endpoint-resolver.js";

export {
  fanOut,
  ingest,
  selectFanoutTargets,
  type FanoutSelection,
  type FanoutDeps,
  type FanoutOptions,
  type FanoutResult,
  type IngestDeps,
  type IngestResult,
} from "./fanout/fanout.js";

export {
  FanoutDispatcher,
  DEFAULT_FANOUT_GRACE_MS,
  DEFAULT_FANOUT_BATCH_SIZE,
  DEFAULT_FANOUT_IDLE_POLL_MS,
  type FanoutDispatcherOptions,
  type SweepResult,
} from "./fanout/fanout-dispatcher.js";

export {
  UnknownAppError,
  createAppId,
  createApiKeyId,
  generateApiKeySecret,
  hashApiKey,
  apiKeyPrefix,
  apiKeyHashesEqual,
  normalizeNewApp,
  applyAppUpdate,
  API_KEY_SECRET_PREFIX,
  type App,
  type NewApp,
  type AppUpdate,
  type ApiKey,
  type CreatedApiKey,
  type AppStore,
  type NormalizedNewApp,
} from "./apps/app.js";

export {
  InMemoryAppStore,
  type InMemoryAppStoreOptions,
} from "./apps/in-memory-app-store.js";

export {
  SqliteAppStore,
  type SqliteAppStoreOptions,
} from "./apps/sqlite-app-store.js";

export {
  createApi,
  type ApiDeps,
  type ApiRequest,
  type ApiResponse,
  type ApiHandler,
} from "./http/api.js";

export {
  createHttpServer,
  DEFAULT_MAX_BODY_BYTES,
  type HttpServerOptions,
} from "./http/server.js";

export {
  matchRoute,
  defineRoutes,
  toSegments,
  type Route,
  type RouteDef,
  type RouteMatch,
  type RouteParams,
} from "./http/router.js";

export {
  loadConfig,
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_DATA_DIR,
  MEMORY_DATA_DIR,
  type GatewayConfig,
  type WorkerConfig,
  type FanoutConfig,
  type Env,
} from "./runtime/config.js";

export {
  createGateway,
  type Gateway,
  type GatewayAddress,
} from "./runtime/gateway.js";
