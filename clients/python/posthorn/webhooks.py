"""Standard Webhooks signing and receiver-side verification — the Python port.

This is a byte-for-byte port of the gateway's signer (``src/signing/webhook-signature.ts``)
plus the receiver ergonomics of ``src/sdk/verify.ts``. The two implementations MUST agree:
a webhook signed by the Node gateway has to verify here and vice-versa. The signed
content is ``{id}.{timestamp}.{payload}``, HMAC-SHA256'd with the base64-decoded secret,
emitted as a ``v1,<base64>`` token; the ``webhook-signature`` header may carry several
space-delimited tokens to support zero-downtime key rotation.

Only the Python standard library is used.

See https://www.standardwebhooks.com/
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Mapping

_SECRET_PREFIX = "whsec_"
_SIGNATURE_VERSION = "v1"
_DEFAULT_TOLERANCE_SECONDS = 5 * 60

#: Canonical header names defined by the Standard Webhooks spec.
HEADER_ID = "webhook-id"
HEADER_TIMESTAMP = "webhook-timestamp"
HEADER_SIGNATURE = "webhook-signature"


class WebhookVerificationError(Exception):
    """Raised for any signing/verification failure. Never leaks the expected value."""


def _decode_secret(secret: str) -> bytes:
    """Decode a ``whsec_``-prefixed (or bare) base64 secret into raw key bytes."""
    raw = secret[len(_SECRET_PREFIX):] if secret.startswith(_SECRET_PREFIX) else secret
    # Tolerate missing padding the way Node's lenient base64 decoder does.
    padded = raw + "=" * (-len(raw) % 4)
    try:
        key = base64.b64decode(padded)
    except (ValueError, base64.binascii.Error):  # type: ignore[attr-defined]
        raise WebhookVerificationError("secret is empty or not valid base64") from None
    if len(key) == 0:
        raise WebhookVerificationError("secret is empty or not valid base64")
    return key


def _digest(secret: str, msg_id: str, timestamp: int, payload: str) -> str:
    """Compute the raw base64 HMAC digest for the signed content."""
    key = _decode_secret(secret)
    to_sign = f"{msg_id}.{timestamp}.{payload}".encode("utf-8")
    mac = hmac.new(key, to_sign, hashlib.sha256).digest()
    return base64.b64encode(mac).decode("ascii")


def sign(secret: str, *, id: str, timestamp: int, payload: str) -> str:
    """Produce a ``webhook-signature`` header value (``v1,<base64>``) for a message."""
    return f"{_SIGNATURE_VERSION},{_digest(secret, id, int(timestamp), payload)}"


def _digests_equal(a: str, b: str) -> bool:
    """Constant-time comparison of two base64-encoded digests."""
    try:
        ab = base64.b64decode(a + "=" * (-len(a) % 4))
        bb = base64.b64decode(b + "=" * (-len(b) % 4))
    except (ValueError, base64.binascii.Error):  # type: ignore[attr-defined]
        return False
    if len(ab) == 0 or len(ab) != len(bb):
        return False
    return hmac.compare_digest(ab, bb)


def verify(
    secret: str,
    *,
    id: str,
    timestamp: str | int,
    signature: str,
    payload: str,
    tolerance_seconds: int = _DEFAULT_TOLERANCE_SECONDS,
    now: int | None = None,
) -> None:
    """Verify a received webhook from its three header values + the raw body.

    Raises :class:`WebhookVerificationError` on any failure (bad timestamp, replay
    outside the tolerance window, or no matching signature); returns ``None`` on success.
    """
    current = int(time.time()) if now is None else now
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        raise WebhookVerificationError("invalid webhook-timestamp header") from None

    if ts < current - tolerance_seconds:
        raise WebhookVerificationError("webhook timestamp is too old")
    if ts > current + tolerance_seconds:
        raise WebhookVerificationError("webhook timestamp is too new")

    expected = _digest(secret, id, ts, payload)

    # Space-delimited list of `version,digest` tokens; a match on any well-formed
    # `v1` token passes (supports key rotation / multi-sign).
    for token in signature.split(" "):
        if not token:
            continue
        version, sep, value = token.partition(",")
        if sep != "," or version != _SIGNATURE_VERSION:
            continue
        if _digests_equal(value, expected):
            return

    raise WebhookVerificationError("no matching signature found")


def verify_webhook(
    secret: str,
    headers: Mapping[str, str],
    raw_body: str,
    *,
    tolerance_seconds: int = _DEFAULT_TOLERANCE_SECONDS,
    now: int | None = None,
) -> None:
    """Verify a received webhook from a raw header mapping and the **raw body string**.

    Pulls the three Standard Webhooks headers case-insensitively and delegates to
    :func:`verify`. Verify against the body bytes exactly as received — before any
    JSON round-trip, which can reorder keys or change whitespace and break the signature.
    """
    lowered = {k.lower(): v for k, v in headers.items()}
    msg_id = lowered.get(HEADER_ID)
    timestamp = lowered.get(HEADER_TIMESTAMP)
    signature = lowered.get(HEADER_SIGNATURE)
    if msg_id is None or timestamp is None or signature is None:
        raise WebhookVerificationError(
            f"missing one or more required webhook headers "
            f"({HEADER_ID}, {HEADER_TIMESTAMP}, {HEADER_SIGNATURE})"
        )
    verify(
        secret,
        id=msg_id,
        timestamp=timestamp,
        signature=signature,
        payload=raw_body,
        tolerance_seconds=tolerance_seconds,
        now=now,
    )


def is_valid_webhook(
    secret: str,
    headers: Mapping[str, str],
    raw_body: str,
    *,
    tolerance_seconds: int = _DEFAULT_TOLERANCE_SECONDS,
    now: int | None = None,
) -> bool:
    """Boolean variant of :func:`verify_webhook` — returns ``False`` instead of raising
    for an ordinary verification failure (other errors still propagate)."""
    try:
        verify_webhook(secret, headers, raw_body, tolerance_seconds=tolerance_seconds, now=now)
        return True
    except WebhookVerificationError:
        return False


def generate_secret(byte_length: int = 24) -> str:
    """Generate a fresh signing secret in ``whsec_<base64>`` form (>= 16 bytes of CSPRNG)."""
    if byte_length < 16:
        raise WebhookVerificationError("secret must be at least 16 bytes")
    return _SECRET_PREFIX + base64.b64encode(secrets.token_bytes(byte_length)).decode("ascii")
