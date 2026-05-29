"""The Posthorn API client — the Python port of the TS SDK's ``PosthornClient``.

A thin, fully-typed-at-the-boundary wrapper over the v1 HTTP surface: authenticate
once with an API key, then send events, manage endpoints, and read delivery status
without hand-rolling ``urllib``, header construction, or error parsing. It is the
*sending* side; receiver-side verification of delivered webhooks lives in
:mod:`posthorn.webhooks`.

Two design choices keep it faithful to the TypeScript SDK it mirrors:

- **Zero third-party dependencies** — only the Python standard library, the same
  posture as the gateway itself (``node:sqlite``/``node:http``/``node:crypto``).
- **The wire is the contract.** Methods return the gateway's JSON decoded into plain
  ``dict``/``list`` values — exactly what crossed the wire, no hand-maintained model
  layer to drift. The method *set*, names, routes, and optional-field semantics mirror
  the TS client one-to-one (see :data:`OPERATIONS`), so a producer can move between the
  two SDKs without surprises.

Every method maps to one documented OpenAPI operation; :data:`OPERATIONS` records that
mapping and is asserted against the live ``/openapi.json`` so the surface cannot silently
drift from the API.
"""

from __future__ import annotations

import urllib.parse
from typing import Any, Mapping, Sequence

from ._http import DEFAULT_TIMEOUT_SECONDS, PosthornError, _Transport

# Sentinel distinguishing "argument omitted" from "explicitly None", mirroring the
# TS SDK's `!== undefined` checks: an omitted optional field is left out of the request
# body entirely, while an explicit `None` is sent as JSON `null` (a meaningful value —
# e.g. clearing an endpoint's channel or filter on update).
_UNSET: Any = object()

# Snake-case kwarg → camelCase wire-field for the optional message fields shared by
# `send_message` and `send_message_batch`.
_OPTIONAL_MESSAGE_FIELDS: tuple[tuple[str, str], ...] = (
    ("idempotency_key", "idempotencyKey"),
    ("send_at", "sendAt"),
    ("expires_at", "expiresAt"),
    ("channel", "channel"),
    ("priority", "priority"),
)

# Snake-case kwarg → camelCase wire-field for the optional endpoint fields shared by
# `create_endpoint` and `update_endpoint`.
_OPTIONAL_ENDPOINT_FIELDS: tuple[tuple[str, str], ...] = (
    ("secret", "secret"),
    ("description", "description"),
    ("event_types", "eventTypes"),
    ("disabled", "disabled"),
    ("headers", "headers"),
    ("retry_policy", "retryPolicy"),
    ("filter", "filter"),
    ("channel", "channel"),
    ("rate_limit", "rateLimit"),
)


def _seg(value: str) -> str:
    """Percent-encode one path segment (the analogue of JS ``encodeURIComponent``)."""
    return urllib.parse.quote(str(value), safe="")


def _path(base: str, params: Sequence[tuple[str, Any]]) -> str:
    """Append a ``?`` query string to ``base`` from ``(key, value)`` pairs.

    A value of :data:`_UNSET` or ``None`` is skipped (matching the TS client, which omits
    both undefined and null query params); booleans are lower-cased; everything else is
    stringified. Returns ``base`` unchanged when nothing survives.
    """
    pairs: list[tuple[str, str]] = []
    for key, value in params:
        if value is _UNSET or value is None:
            continue
        if isinstance(value, bool):
            pairs.append((key, "true" if value else "false"))
        else:
            pairs.append((key, str(value)))
    if not pairs:
        return base
    return base + "?" + urllib.parse.urlencode(pairs)


def _message_body(msg: Mapping[str, Any]) -> dict[str, Any]:
    """Build one message's wire body from a mapping of snake_case fields.

    ``event_type`` and ``payload`` are required; the optional fields in
    :data:`_OPTIONAL_MESSAGE_FIELDS` are included only when present and not :data:`_UNSET`.
    """
    if "event_type" not in msg or msg["event_type"] is _UNSET:
        raise PosthornError("each message requires an 'event_type'")
    if "payload" not in msg:
        raise PosthornError("each message requires a 'payload'")
    body: dict[str, Any] = {"eventType": msg["event_type"], "payload": msg["payload"]}
    for snake, camel in _OPTIONAL_MESSAGE_FIELDS:
        value = msg.get(snake, _UNSET)
        if value is not _UNSET:
            body[camel] = value
    return body


class PosthornClient:
    """A client for one Posthorn gateway. Construct one per ``(base_url, api_key)`` pair
    and reuse it; it holds no per-request mutable state.

    :param base_url: Gateway base URL, e.g. ``"https://posthorn.example"``. A trailing
        slash is tolerated and stripped.
    :param api_key: The API key, sent as ``Authorization: Bearer <api_key>`` on every
        request. Mint one with ``posthorn admin create-key`` or ``POST /v1/signup``.
    :param timeout: Per-request timeout in seconds (default
        :data:`posthorn._http.DEFAULT_TIMEOUT_SECONDS`). A timed-out request raises
        :class:`posthorn.PosthornTimeoutError`.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._transport = _Transport(base_url, api_key, timeout=timeout)

    # -- Operational -------------------------------------------------------------------

    def health(self) -> Any:
        """Liveness probe — ``GET /healthz``. Returns ``{"status": "ok"}``."""
        return self._transport.request("GET", "/healthz")

    # -- Messages ----------------------------------------------------------------------

    def send_message(
        self,
        *,
        event_type: str,
        payload: Any,
        idempotency_key: Any = _UNSET,
        send_at: Any = _UNSET,
        expires_at: Any = _UNSET,
        channel: Any = _UNSET,
        priority: Any = _UNSET,
    ) -> Any:
        """Accept an event and fan it out to subscribed endpoints — ``POST /v1/messages``.

        ``idempotency_key`` makes a repeat send return the original message instead of
        re-delivering (reusing a key with a different payload is a ``409``). ``send_at`` /
        ``expires_at`` are ISO-8601 strings; ``channel`` scopes delivery; ``priority`` is
        ``"high"``/``"normal"``/``"low"``.
        """
        body = _message_body(
            {
                "event_type": event_type,
                "payload": payload,
                "idempotency_key": idempotency_key,
                "send_at": send_at,
                "expires_at": expires_at,
                "channel": channel,
                "priority": priority,
            }
        )
        return self._transport.request("POST", "/v1/messages", body)

    def send_message_batch(self, messages: Sequence[Mapping[str, Any]]) -> Any:
        """Accept up to 100 messages in one call — ``POST /v1/messages/batch``.

        Each item is a mapping with ``event_type`` and ``payload`` (and the same optional
        snake_case fields as :meth:`send_message`). Each is processed independently;
        inspect ``result["ok"]`` on every element of the response to detect per-item errors.
        """
        items = [_message_body(m) for m in messages]
        return self._transport.request("POST", "/v1/messages/batch", {"messages": items})

    def list_messages(
        self,
        *,
        limit: Any = _UNSET,
        cursor: Any = _UNSET,
        event_type: Any = _UNSET,
        channel: Any = _UNSET,
        after: Any = _UNSET,
        before: Any = _UNSET,
    ) -> Any:
        """List the tenant's messages, newest-first — ``GET /v1/messages``.

        Keyset-paginated: pass the returned ``nextCursor`` back as ``cursor`` to page
        forward (it is ``None`` on the last page). Optionally filter by ``event_type`` /
        ``channel`` and a half-open ``[after, before)`` ``createdAt`` window (epoch ms):
        ``after`` is an inclusive lower bound, ``before`` an exclusive upper bound.
        """
        path = _path(
            "/v1/messages",
            [
                ("limit", limit),
                ("cursor", cursor),
                ("eventType", event_type),
                ("channel", channel),
                ("after", after),
                ("before", before),
            ],
        )
        return self._transport.request("GET", path)

    def get_message(self, message_id: str) -> Any:
        """Read a message and its per-endpoint delivery statuses — ``GET /v1/messages/:id``."""
        return self._transport.request("GET", f"/v1/messages/{_seg(message_id)}")

    def list_message_attempts(
        self,
        message_id: str,
        *,
        limit: Any = _UNSET,
        cursor: Any = _UNSET,
    ) -> Any:
        """List a message's per-attempt delivery audit log, oldest-first —
        ``GET /v1/messages/:id/attempts``. Keyset-paginated via ``cursor``."""
        path = _path(
            f"/v1/messages/{_seg(message_id)}/attempts",
            [("limit", limit), ("cursor", cursor)],
        )
        return self._transport.request("GET", path)

    def retry_message(self, message_id: str) -> Any:
        """Replay a message's dead-lettered deliveries — ``POST /v1/messages/:id/retry``."""
        return self._transport.request("POST", f"/v1/messages/{_seg(message_id)}/retry")

    def cancel_message(self, message_id: str) -> Any:
        """Cancel a message's pending deliveries — ``POST /v1/messages/:id/cancel``."""
        return self._transport.request("POST", f"/v1/messages/{_seg(message_id)}/cancel")

    # -- Endpoints ---------------------------------------------------------------------

    def list_endpoints(self) -> Any:
        """List the tenant's endpoints — ``GET /v1/endpoints``. Returns the array directly
        (the ``{"data": [...]}`` envelope is unwrapped, matching the TS client)."""
        res = self._transport.request("GET", "/v1/endpoints")
        return res["data"] if isinstance(res, dict) else res

    def create_endpoint(
        self,
        *,
        url: str,
        event_types: Any = _UNSET,
        description: Any = _UNSET,
        disabled: Any = _UNSET,
        secret: Any = _UNSET,
        headers: Any = _UNSET,
        retry_policy: Any = _UNSET,
        filter: Any = _UNSET,
        channel: Any = _UNSET,
        rate_limit: Any = _UNSET,
    ) -> Any:
        """Create an endpoint — ``POST /v1/endpoints``. The returned object carries the
        signing ``secret`` **exactly once**; persist it for receiver-side verification.

        Omit ``event_types`` (or pass ``None``) to subscribe to all events; omit ``secret``
        to have a secure one generated.
        """
        body: dict[str, Any] = {"url": url}
        provided = {
            "secret": secret,
            "description": description,
            "event_types": event_types,
            "disabled": disabled,
            "headers": headers,
            "retry_policy": retry_policy,
            "filter": filter,
            "channel": channel,
            "rate_limit": rate_limit,
        }
        for snake, camel in _OPTIONAL_ENDPOINT_FIELDS:
            if provided[snake] is not _UNSET:
                body[camel] = provided[snake]
        return self._transport.request("POST", "/v1/endpoints", body)

    def get_endpoint(self, endpoint_id: str) -> Any:
        """Fetch one endpoint — ``GET /v1/endpoints/:id``."""
        return self._transport.request("GET", f"/v1/endpoints/{_seg(endpoint_id)}")

    def update_endpoint(
        self,
        endpoint_id: str,
        *,
        url: Any = _UNSET,
        secret: Any = _UNSET,
        description: Any = _UNSET,
        event_types: Any = _UNSET,
        disabled: Any = _UNSET,
        headers: Any = _UNSET,
        retry_policy: Any = _UNSET,
        filter: Any = _UNSET,
        channel: Any = _UNSET,
        rate_limit: Any = _UNSET,
    ) -> Any:
        """Update an endpoint — ``PATCH /v1/endpoints/:id``. Only provided fields change;
        pass ``None`` to clear a nullable field (headers/filter/channel/rate_limit/retry_policy)."""
        body: dict[str, Any] = {}
        if url is not _UNSET:
            body["url"] = url
        provided = {
            "secret": secret,
            "description": description,
            "event_types": event_types,
            "disabled": disabled,
            "headers": headers,
            "retry_policy": retry_policy,
            "filter": filter,
            "channel": channel,
            "rate_limit": rate_limit,
        }
        for snake, camel in _OPTIONAL_ENDPOINT_FIELDS:
            if provided[snake] is not _UNSET:
                body[camel] = provided[snake]
        return self._transport.request("PATCH", f"/v1/endpoints/{_seg(endpoint_id)}", body)

    def delete_endpoint(self, endpoint_id: str) -> None:
        """Delete an endpoint — ``DELETE /v1/endpoints/:id``."""
        self._transport.request("DELETE", f"/v1/endpoints/{_seg(endpoint_id)}")

    def rotate_endpoint_secret(
        self,
        endpoint_id: str,
        *,
        secret: Any = _UNSET,
        overlap_ms: Any = _UNSET,
    ) -> Any:
        """Rotate an endpoint's signing secret with zero downtime —
        ``POST /v1/endpoints/:id/rotate-secret``. The **new** secret is returned once;
        the old one keeps signing for ``overlap_ms`` so no webhook is dropped mid-rotation."""
        body: dict[str, Any] = {}
        if secret is not _UNSET:
            body["secret"] = secret
        if overlap_ms is not _UNSET:
            body["overlapMs"] = overlap_ms
        return self._transport.request(
            "POST", f"/v1/endpoints/{_seg(endpoint_id)}/rotate-secret", body
        )

    def test_endpoint(
        self,
        endpoint_id: str,
        *,
        event_type: Any = _UNSET,
        payload: Any = _UNSET,
    ) -> Any:
        """Send a one-shot synchronous test delivery — ``POST /v1/endpoints/:id/test``.
        Not stored, not queued, not billed. Defaults to ``event_type="test"`` /
        ``payload={"test": true}`` when omitted. Supplying an ``event_type`` that
        exists in the catalog (without ``payload``) sends that type's registered
        ``schemaExample``; the result's ``payloadSource`` reports which was used."""
        body: dict[str, Any] = {}
        if event_type is not _UNSET:
            body["eventType"] = event_type
        if payload is not _UNSET:
            body["payload"] = payload
        return self._transport.request("POST", f"/v1/endpoints/{_seg(endpoint_id)}/test", body)

    def list_endpoint_deliveries(
        self,
        endpoint_id: str,
        *,
        limit: Any = _UNSET,
        cursor: Any = _UNSET,
    ) -> Any:
        """List an endpoint's delivery history, newest-first —
        ``GET /v1/endpoints/:id/deliveries``. Keyset-paginated via ``cursor``."""
        path = _path(
            f"/v1/endpoints/{_seg(endpoint_id)}/deliveries",
            [("limit", limit), ("cursor", cursor)],
        )
        return self._transport.request("GET", path)

    def retry_endpoint_deliveries(self, endpoint_id: str) -> Any:
        """Bulk-retry one endpoint's dead-lettered deliveries —
        ``POST /v1/endpoints/:id/deliveries/retry``. Re-invoke while ``hasMore`` is true."""
        return self._transport.request(
            "POST", f"/v1/endpoints/{_seg(endpoint_id)}/deliveries/retry"
        )

    def replay_endpoint(
        self,
        endpoint_id: str,
        *,
        since: Any = _UNSET,
        until: Any = _UNSET,
        limit: Any = _UNSET,
    ) -> Any:
        """Replay historical messages to one endpoint — ``POST /v1/endpoints/:id/replay``.
        ``since``/``until`` are epoch-ms bounds; re-invoke while ``hasMore`` is true."""
        body: dict[str, Any] = {}
        if since is not _UNSET:
            body["since"] = since
        if until is not _UNSET:
            body["until"] = until
        if limit is not _UNSET:
            body["limit"] = limit
        return self._transport.request(
            "POST", f"/v1/endpoints/{_seg(endpoint_id)}/replay", body or None
        )

    def get_endpoint_stats(self, endpoint_id: str, *, days: Any = _UNSET) -> Any:
        """Aggregate delivery-attempt statistics for an endpoint —
        ``GET /v1/endpoints/:id/stats`` over a trailing window of ``days`` (1–30, default 7)."""
        path = _path(f"/v1/endpoints/{_seg(endpoint_id)}/stats", [("days", days)])
        return self._transport.request("GET", path)

    # -- Deliveries --------------------------------------------------------------------

    def list_deliveries(
        self,
        *,
        limit: Any = _UNSET,
        cursor: Any = _UNSET,
        status: Any = _UNSET,
        failure_reason: Any = _UNSET,
    ) -> Any:
        """List all of the tenant's deliveries, newest-first — ``GET /v1/deliveries``.
        Filter by ``status`` (e.g. ``"dead_letter"``) and/or ``failure_reason``
        (e.g. ``"connection_refused"``); the two compose. Keyset-paginated via ``cursor``."""
        path = _path(
            "/v1/deliveries",
            [
                ("status", status),
                ("failureReason", failure_reason),
                ("limit", limit),
                ("cursor", cursor),
            ],
        )
        return self._transport.request("GET", path)

    def get_delivery(self, delivery_id: str) -> Any:
        """Fetch a single delivery by ID — ``GET /v1/deliveries/:id``."""
        return self._transport.request("GET", f"/v1/deliveries/{_seg(delivery_id)}")

    def list_delivery_attempts(
        self,
        delivery_id: str,
        *,
        limit: Any = _UNSET,
        cursor: Any = _UNSET,
    ) -> Any:
        """List the attempt history for a single delivery, oldest-first —
        ``GET /v1/deliveries/:id/attempts``. Keyset-paginated via ``cursor``."""
        path = _path(
            f"/v1/deliveries/{_seg(delivery_id)}/attempts",
            [("limit", limit), ("cursor", cursor)],
        )
        return self._transport.request("GET", path)

    def retry_all_deliveries(self) -> Any:
        """Bulk-retry the tenant's dead-lettered deliveries — ``POST /v1/deliveries/retry``.
        Re-invoke while ``hasMore`` is true to fully drain the backlog."""
        return self._transport.request("POST", "/v1/deliveries/retry")

    # -- Usage -------------------------------------------------------------------------

    def get_usage(self, *, from_: Any = _UNSET, to: Any = _UNSET) -> Any:
        """Read your own usage and current-month quota status — ``GET /v1/usage``.
        Defaults to the current UTC month; pass ``from_``/``to`` (inclusive ``YYYY-MM-DD``
        UTC days) for a historical window. ``quota`` always reports the current month."""
        path = _path("/v1/usage", [("from", from_), ("to", to)])
        return self._transport.request("GET", path)

    # -- Portal ------------------------------------------------------------------------

    def create_portal_session(
        self,
        *,
        external_user_id: str,
        expires_in: Any = _UNSET,
    ) -> Any:
        """Mint a consumer portal session — ``POST /v1/portal/sessions``. Returns a
        ``token`` and ``portalUrl`` to redirect your customer to. ``expires_in`` is in
        seconds (default 86400, max 604800)."""
        body: dict[str, Any] = {"externalUserId": external_user_id}
        if expires_in is not _UNSET:
            body["expiresIn"] = expires_in
        return self._transport.request("POST", "/v1/portal/sessions", body)

    # -- Event types -------------------------------------------------------------------

    def list_event_types(self, *, include_archived: bool = False) -> Any:
        """List the tenant's event-type catalog — ``GET /v1/event-types``. Set
        ``include_archived=True`` to include archived types."""
        path = "/v1/event-types"
        if include_archived:
            path += "?includeArchived=true"
        return self._transport.request("GET", path)

    def create_event_type(
        self,
        *,
        id: str,
        name: str,
        description: Any = _UNSET,
        schema_example: Any = _UNSET,
    ) -> Any:
        """Create an event type — ``POST /v1/event-types``."""
        body: dict[str, Any] = {"id": id, "name": name}
        if description is not _UNSET:
            body["description"] = description
        if schema_example is not _UNSET:
            body["schemaExample"] = schema_example
        return self._transport.request("POST", "/v1/event-types", body)

    def get_event_type(self, event_type_id: str) -> Any:
        """Fetch one event type — ``GET /v1/event-types/:id``."""
        return self._transport.request("GET", f"/v1/event-types/{_seg(event_type_id)}")

    def update_event_type(
        self,
        event_type_id: str,
        *,
        name: Any = _UNSET,
        description: Any = _UNSET,
        schema_example: Any = _UNSET,
    ) -> Any:
        """Update an event type — ``PATCH /v1/event-types/:id``. Only provided fields change."""
        body: dict[str, Any] = {}
        if name is not _UNSET:
            body["name"] = name
        if description is not _UNSET:
            body["description"] = description
        if schema_example is not _UNSET:
            body["schemaExample"] = schema_example
        return self._transport.request("PATCH", f"/v1/event-types/{_seg(event_type_id)}", body)

    def archive_event_type(self, event_type_id: str) -> None:
        """Archive an event type (soft delete) — ``DELETE /v1/event-types/:id``."""
        self._transport.request("DELETE", f"/v1/event-types/{_seg(event_type_id)}")
