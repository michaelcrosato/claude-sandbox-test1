from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import time
from typing import Mapping, Optional, Union

WEBHOOK_ID_HEADER = "webhook-id"
WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp"
WEBHOOK_SIGNATURE_HEADER = "webhook-signature"
WEBHOOK_SECRET_PREFIX = "whsec_"
DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300
MIN_SECRET_BYTES = 24
MAX_SECRET_BYTES = 64


class WebhookVerificationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def verify_webhook(
    secret: str,
    headers: Mapping[str, object],
    body: Union[bytes, str],
    tolerance_seconds: int = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> dict:
    webhook_id = _required_header(headers, WEBHOOK_ID_HEADER)
    timestamp_header = _required_header(headers, WEBHOOK_TIMESTAMP_HEADER)
    signature_header = _required_header(headers, WEBHOOK_SIGNATURE_HEADER)
    timestamp = _parse_timestamp(timestamp_header)
    now_seconds = int(time.time()) if now is None else now

    if not isinstance(tolerance_seconds, int) or tolerance_seconds < 0:
        raise WebhookVerificationError("invalid_timestamp", "Webhook tolerance must be a non-negative integer.")
    if not isinstance(now_seconds, int) or now_seconds < 0:
        raise WebhookVerificationError("invalid_timestamp", "Current webhook time must be a non-negative integer.")
    if "." in webhook_id or any(char.isspace() for char in webhook_id):
        raise WebhookVerificationError("invalid_header", "Webhook id header is invalid.")
    if abs(now_seconds - timestamp) > tolerance_seconds:
        raise WebhookVerificationError(
            "timestamp_outside_tolerance",
            "Webhook timestamp is outside the allowed replay window.",
        )

    key = _decode_secret(secret)
    signatures = _parse_signatures(signature_header)
    body_bytes = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    signed = f"{webhook_id}.{timestamp}.".encode("utf-8") + body_bytes
    expected = hmac.new(key, signed, hashlib.sha256).digest()

    for signature in signatures:
        if hmac.compare_digest(expected, signature):
            return {"id": webhook_id, "timestamp_seconds": timestamp}

    raise WebhookVerificationError("signature_mismatch", "Webhook signature does not match.")


def _required_header(headers: Mapping[str, object], name: str) -> str:
    value = _read_header(headers, name)
    if value is None or value.strip() == "":
        raise WebhookVerificationError("missing_header", f"Missing required webhook header: {name}.")
    return value.strip()


def _read_header(headers: Mapping[str, object], name: str) -> Optional[str]:
    lower_name = name.lower()
    for key, value in headers.items():
        if key.lower() == lower_name:
            if value is None:
                return None
            if isinstance(value, (list, tuple)):
                return " ".join(str(item) for item in value)
            return str(value)
    return None


def _parse_timestamp(value: str) -> int:
    if not value.isdigit():
        raise WebhookVerificationError("invalid_timestamp", "Webhook timestamp must be an integer Unix timestamp.")
    try:
        return int(value)
    except ValueError as exc:
        raise WebhookVerificationError("invalid_timestamp", "Webhook timestamp must be a safe integer.") from exc


def _decode_secret(secret: str) -> bytes:
    if not isinstance(secret, str) or not secret.startswith(WEBHOOK_SECRET_PREFIX):
        raise WebhookVerificationError("invalid_secret", f"Webhook secret must start with {WEBHOOK_SECRET_PREFIX}.")
    encoded = secret[len(WEBHOOK_SECRET_PREFIX) :]
    decoded = _decode_base64(encoded, "invalid_secret", "Webhook secret must be base64 encoded.")
    if len(decoded) < MIN_SECRET_BYTES or len(decoded) > MAX_SECRET_BYTES:
        raise WebhookVerificationError(
            "invalid_secret",
            f"Webhook secret must decode to {MIN_SECRET_BYTES}-{MAX_SECRET_BYTES} bytes.",
        )
    return decoded


def _parse_signatures(value: str) -> list:
    signatures = []
    for token in value.strip().split():
        if "," not in token:
            raise WebhookVerificationError("invalid_header", "Webhook signature header is malformed.")
        version, encoded = token.split(",", 1)
        if version != "v1":
            continue
        signatures.append(_decode_base64(encoded, "invalid_header", "Webhook signature must be base64 encoded."))
    if not signatures:
        raise WebhookVerificationError("signature_mismatch", "No supported webhook signatures were provided.")
    return signatures


def _decode_base64(encoded: str, code: str, message: str) -> bytes:
    if not isinstance(encoded, str) or encoded == "":
        raise WebhookVerificationError(code, message)
    normalized = encoded.strip()
    normalized = normalized + ("=" * (-len(normalized) % 4))
    try:
        return base64.b64decode(normalized, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise WebhookVerificationError(code, message) from exc
