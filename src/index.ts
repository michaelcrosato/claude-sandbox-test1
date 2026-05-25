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
  DEFAULT_LIST_MESSAGES_LIMIT,
  MAX_LIST_MESSAGES_LIMIT,
  MAX_USAGE_RANGE_DAYS,
  encodeMessageCursor,
  decodeMessageCursor,
  utcDayKey,
  utcMonthRange,
  normalizeNewMessage,
  type Message,
  type NewMessage,
  type NormalizedNewMessage,
  type CreateMessageResult,
  type ListPendingFanoutOptions,
  type ListMessagesOptions,
  type MessagePage,
  type MessageCursor,
  type MessageStore,
  type UsageRange,
  type UsageDay,
  type UsageSummary,
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
  PostgresMessageStore,
  type PostgresMessageStoreOptions,
} from "./storage/postgres-store.js";

export {
  UnknownDeliveryTaskError,
  StaleLeaseError,
  createTaskId,
  createLeaseToken,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LIST_DELIVERIES_LIMIT,
  MAX_LIST_DELIVERIES_LIMIT,
  encodeDeliveryCursor,
  decodeDeliveryCursor,
  type DeliveryQueue,
  type DeliveryTask,
  type EnqueueInput,
  type ClaimOptions,
  type FailInput,
  type ListDeliveriesOptions,
  type ListByAppOptions,
  type ListByEndpointOptions,
  type DeliveryPage,
  type DeliveryCursor,
} from "./queue/delivery-queue.js";

export {
  retryMessageDeliveries,
  type RetryMessageDeps,
  type RetryMessageResult,
} from "./queue/retry-message.js";

export {
  retryAppDeliveries,
  retryEndpointDeliveries,
  DEFAULT_BULK_RETRY_LIMIT,
  type BulkRetryResult,
  type RetryAppDeps,
} from "./queue/retry-app.js";

export {
  replayEndpointMessages,
  normalizeReplayLimit,
  DEFAULT_REPLAY_LIMIT,
  MAX_REPLAY_LIMIT,
  type ReplayOptions,
  type ReplayResult,
  type ReplayDeps,
} from "./queue/replay-endpoint.js";

export {
  InMemoryDeliveryQueue,
  type InMemoryQueueOptions,
} from "./queue/in-memory-queue.js";

export {
  SqliteDeliveryQueue,
  type SqliteQueueOptions,
} from "./queue/sqlite-queue.js";

export {
  PostgresDeliveryQueue,
  type PostgresQueueOptions,
} from "./queue/postgres-queue.js";

export {
  createAttemptId,
  normalizeNewAttempt,
  type DeliveryAttempt,
  type DeliveryAttemptOutcome,
  type NewDeliveryAttempt,
  type NormalizedNewAttempt,
  type DeliveryAttemptStore,
  type AttemptUsageDay,
  type AttemptUsageSummary,
  type EndpointStats,
  type EndpointStatsDay,
  DEFAULT_STATS_DAYS,
  MAX_CAPTURED_BODY_BYTES,
  MAX_STATS_DAYS,
} from "./attempts/delivery-attempt.js";

export {
  InMemoryDeliveryAttemptStore,
  type InMemoryDeliveryAttemptStoreOptions,
} from "./attempts/in-memory-attempt-store.js";

export {
  SqliteDeliveryAttemptStore,
  type SqliteDeliveryAttemptStoreOptions,
} from "./attempts/sqlite-attempt-store.js";

export {
  PostgresDeliveryAttemptStore,
  type PostgresAttemptStoreOptions,
} from "./attempts/postgres-attempt-store.js";

export {
  DeliveryWorker,
  buildSignedRequest,
  isSuccessStatus,
  fetchTransport,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_WORKER_BATCH_SIZE,
  DEFAULT_WORKER_CONCURRENCY,
  MAX_RETRY_AFTER_MS,
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
  matchesFilter,
  normalizeChannel,
  normalizeEndpointFilter,
  normalizeNewEndpoint,
  normalizeRetryPolicy,
  applyEndpointUpdate,
  activeSigningSecrets,
  rotateEndpointSecret,
  evaluateEndpointHealth,
  DEFAULT_SECRET_ROTATION_OVERLAP_MS,
  MAX_CHANNEL_LENGTH,
  MAX_PREVIOUS_SECRETS,
  DEFAULT_AUTO_DISABLE_AFTER_MS,
  MAX_RETRY_POLICY_RETRIES,
  MAX_RETRY_POLICY_DELAY_MS,
  MAX_NON_RETRYABLE_STATUSES,
  MAX_FILTER_NODES,
  MAX_FILTER_DEPTH,
  type Endpoint,
  type ExpiringSecret,
  type NewEndpoint,
  type EndpointUpdate,
  type RotateSecretOptions,
  type EndpointStore,
  type NormalizedNewEndpoint,
  type DeliveryHealthOutcome,
  type EndpointHealthEvaluation,
  type EndpointFilter,
  type FieldFilter,
  type AndFilter,
  type OrFilter,
  type NotFilter,
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
  PostgresEndpointStore,
  type PostgresEndpointStoreOptions,
} from "./endpoints/postgres-endpoint-store.js";

export {
  storeBackedResolver,
  endpointToDeliveryTarget,
  type StoreBackedResolverOptions,
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
  DataPruner,
  DEFAULT_PRUNER_SWEEP_INTERVAL_MS,
  type DataPrunerOptions,
  type PruneResult,
} from "./pruner/data-pruner.js";

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
  normalizeQuota,
  isQuotaExceeded,
  quotaRemaining,
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
  PostgresAppStore,
  type PostgresAppStoreOptions,
} from "./apps/postgres-app-store.js";

export {
  DuplicateEventTypeError,
  UnknownEventTypeError,
  type EventType,
  type NewEventType,
  type EventTypeUpdate,
  type ListEventTypesOptions,
  type EventTypeStore,
} from "./event-types/event-type.js";

export {
  PostgresEventTypeStore,
  type PostgresEventTypeStoreOptions,
} from "./event-types/postgres-event-type-store.js";

export {
  createPostgresPool,
  type Pool,
  type PoolClient,
} from "./db/postgres.js";

export {
  createApi,
  API_ROUTE_KEYS,
  patternToOpenApiPath,
  type ApiDeps,
  type ApiRequest,
  type ApiResponse,
  type ApiHandler,
  type ApiRouteKey,
} from "./http/api.js";

export {
  buildOpenApiDocument,
  type OpenApiDocument,
} from "./http/openapi.js";

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
  MIN_ADMIN_TOKEN_LENGTH,
  type GatewayConfig,
  type WorkerConfig,
  type FanoutConfig,
  type Env,
} from "./runtime/config.js";

export {
  createGateway,
  resolveLocations,
  type Gateway,
  type GatewayAddress,
  type StoreLocations,
} from "./runtime/gateway.js";

export {
  runAdminCommand,
  ADMIN_USAGE,
  type AdminDeps,
} from "./runtime/admin.js";

export {
  PosthornClient,
  PosthornError,
  PosthornApiError,
  PosthornTimeoutError,
  DEFAULT_TIMEOUT_MS,
  type PosthornClientOptions,
  type PosthornFetch,
  type PosthornRequestInit,
  type PosthornResponse,
  type SendMessageInput,
  type SendMessageResult,
  type MessageRef,
  type FanoutSummary,
  type ListMessagesParams,
  type MessageListPage,
  type MessageWithDeliveries,
  type RetryMessageResponse,
  type ReplayEndpointInput,
  type ReplayEndpointResponse,
  type DeliveryView,
  type DeliveryAttemptView,
  type EndpointView,
  type CreatedEndpoint,
  type CreateEndpointInput,
  type UpdateEndpointInput,
  type RotateEndpointSecretInput,
  type TenantUsage,
  type DeliveryUsage,
  type DeliveryUsageDay,
  type QuotaStatus,
  type GetUsageParams,
  type RetryPolicyView,
  type EndpointFilterView,
  type EventTypeView,
  type CreateEventTypeInput,
  type UpdateEventTypeInput,
  type EventTypeListPage,
  type ListEventTypesParams,
} from "./sdk/client.js";

export {
  PosthornAdminClient,
  type PosthornAdminClientOptions,
  type AdminApp,
  type CreateAppInput,
  type UpdateAppInput,
  type AdminApiKey,
  type CreatedAdminApiKey,
  type AdminUsage,
  type AdminUsageDay,
  type AdminDeliveryUsage,
  type AdminDeliveryUsageDay,
  type GetAppUsageParams,
} from "./sdk/admin-client.js";

export {
  verifyWebhook,
  isValidWebhook,
  type IncomingHeaders,
} from "./sdk/verify.js";

export {
  MetricsRegistry,
  renderPrometheus,
  PROMETHEUS_CONTENT_TYPE,
  type MetricsCounters,
  type DeliveryOutcomeCounts,
  type MetricsSnapshot,
  type MetricsRegistryOptions,
} from "./metrics/metrics.js";

export {
  zeroDeliveryCounts,
  type DeliveryCountsByStatus,
} from "./queue/delivery-queue.js";

export {
  BlockedUrlError,
  assertUrlDeliverable,
  isUrlDeliverable,
  isBlockedHost,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  type SsrfPolicy,
} from "./net/ssrf-guard.js";

export {
  createGuardedLookup,
  type AddressResolver,
} from "./net/guarded-lookup.js";

export {
  createGuardedTransport,
  type GuardedTransportOptions,
} from "./net/guarded-transport.js";

export { POSTHORN_VERSION } from "./version.js";
