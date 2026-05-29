"""Posthorn — the official Python SDK for the Posthorn webhook delivery gateway.

A zero-dependency (Python standard library only) port of the TypeScript SDK, with the
same surface and wire contract:

- :class:`PosthornClient` — the *sending* side: send events, manage endpoints, read
  delivery status (mirrors the TS ``PosthornClient``).
- :func:`verify_webhook` / :func:`verify` / :func:`is_valid_webhook` — the *receiving*
  side: Standard Webhooks signature verification (mirrors the TS ``verifyWebhook``).
- :func:`sign` / :func:`generate_secret` — the signing primitives, so a Python service
  can produce signatures the Node gateway accepts and vice-versa.

The error model mirrors the TS SDK exactly: :class:`PosthornError` (base),
:class:`PosthornApiError` (a non-2xx response, carrying ``status`` and the machine-readable
``code``), and :class:`PosthornTimeoutError`.

See https://www.standardwebhooks.com/ and the project README.
"""

from __future__ import annotations

from ._http import (
    DEFAULT_TIMEOUT_SECONDS,
    PosthornApiError,
    PosthornError,
    PosthornTimeoutError,
)
from .client import PosthornClient
from .webhooks import (
    HEADER_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    WebhookVerificationError,
    generate_secret,
    is_valid_webhook,
    sign,
    verify,
    verify_webhook,
)

__version__ = "1.0.0"

__all__ = [
    "PosthornClient",
    "PosthornError",
    "PosthornApiError",
    "PosthornTimeoutError",
    "DEFAULT_TIMEOUT_SECONDS",
    "WebhookVerificationError",
    "sign",
    "verify",
    "verify_webhook",
    "is_valid_webhook",
    "generate_secret",
    "HEADER_ID",
    "HEADER_TIMESTAMP",
    "HEADER_SIGNATURE",
    "OPERATIONS",
    "EXCLUDED_OPERATIONS",
    "__version__",
]

#: Map of every OpenAPI ``operationId`` this client implements → the :class:`PosthornClient`
#: method that implements it. This is the producer/tenant surface — the cross-language
#: mirror of the TS ``PosthornClient``. It is asserted against the live ``/openapi.json``
#: (see ``clients/python/tests/e2e.py``): every key must name a real method on the client,
#: and every in-scope operation in the spec must be a key here, so the SDK cannot silently
#: drift from the documented API. Partner of :data:`EXCLUDED_OPERATIONS`.
OPERATIONS: dict[str, str] = {
    # Operational
    "getHealth": "health",
    # Messages
    "sendMessage": "send_message",
    "sendMessageBatch": "send_message_batch",
    "listMessages": "list_messages",
    "getMessage": "get_message",
    "listMessageAttempts": "list_message_attempts",
    "retryMessage": "retry_message",
    "cancelMessage": "cancel_message",
    # Endpoints
    "listEndpoints": "list_endpoints",
    "createEndpoint": "create_endpoint",
    "getEndpoint": "get_endpoint",
    "updateEndpoint": "update_endpoint",
    "deleteEndpoint": "delete_endpoint",
    "listEndpointDeliveries": "list_endpoint_deliveries",
    "retryEndpointDeliveries": "retry_endpoint_deliveries",
    "replayEndpoint": "replay_endpoint",
    "getEndpointStats": "get_endpoint_stats",
    "rotateEndpointSecret": "rotate_endpoint_secret",
    "testEndpoint": "test_endpoint",
    # Deliveries
    "listDeliveries": "list_deliveries",
    "getDelivery": "get_delivery",
    "listDeliveryAttempts": "list_delivery_attempts",
    "retryAllDeliveries": "retry_all_deliveries",
    # Usage
    "getUsage": "get_usage",
    # Portal
    "createPortalSession": "create_portal_session",
    # Event types
    "listEventTypes": "list_event_types",
    "createEventType": "create_event_type",
    "getEventType": "get_event_type",
    "updateEventType": "update_event_type",
    "archiveEventType": "archive_event_type",
}

#: OpenAPI ``operationId``s the producer SDK deliberately does **not** implement, each with
#: the reason. These fall outside the authenticated tenant/producer surface: infra probes
#: and the spec document, the unauthenticated onboarding call, the provider-signed inbound
#: billing webhook, and the operator control-plane (a separate admin client). Asserted
#: alongside :data:`OPERATIONS`: together they must partition the spec's operations exactly,
#: so a newly-added route forces a conscious decision (implement it, or exclude it here)
#: rather than slipping through unnoticed.
EXCLUDED_OPERATIONS: dict[str, str] = {
    "getReadiness": "infrastructure readiness probe, not a producer API call",
    "getMetrics": "Prometheus metrics scrape endpoint",
    "getOpenApiDocument": "the OpenAPI document itself",
    "signup": "unauthenticated self-serve onboarding (no API key yet)",
    "billingWebhook": "inbound provider-signed billing webhook, not a tenant call",
    "createApp": "operator control-plane (admin client)",
    "listApps": "operator control-plane (admin client)",
    "getApp": "operator control-plane (admin client)",
    "updateApp": "operator control-plane (admin client)",
    "deleteApp": "operator control-plane (admin client)",
    "rotateSystemWebhookSecret": "operator control-plane (admin client)",
    "createApiKey": "operator control-plane (admin client)",
    "listApiKeys": "operator control-plane (admin client)",
    "getAppUsage": "operator control-plane (admin client)",
    "revokeApiKey": "operator control-plane (admin client)",
}
