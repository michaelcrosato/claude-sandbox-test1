"""Unit tests for :mod:`posthorn.webhooks` — the Standard Webhooks signer/verifier.

Standard library ``unittest`` only (no pytest), runnable with
``python -m unittest`` from ``clients/python`` (with that directory on ``PYTHONPATH``).
The cross-language interop check (Node signs → Python verifies) lives in the e2e smoke;
here we pin the Python implementation's own behavior.
"""

import unittest

from posthorn import (
    WebhookVerificationError,
    generate_secret,
    is_valid_webhook,
    sign,
    verify,
    verify_webhook,
)

# A fixed, valid secret and message so the assertions are deterministic.
SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
MSG_ID = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W"
TIMESTAMP = 1_700_000_000
PAYLOAD = '{"event":"user.created","data":{"id":1}}'


class SignTests(unittest.TestCase):
    def test_sign_emits_versioned_token(self) -> None:
        token = sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        self.assertTrue(token.startswith("v1,"))
        # The digest after the comma is non-empty base64.
        _, _, value = token.partition(",")
        self.assertTrue(len(value) > 0)

    def test_sign_is_deterministic(self) -> None:
        a = sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        b = sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        self.assertEqual(a, b)

    def test_sign_changes_with_each_input_component(self) -> None:
        base = sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        self.assertNotEqual(base, sign(SECRET, id="other", timestamp=TIMESTAMP, payload=PAYLOAD))
        self.assertNotEqual(base, sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP + 1, payload=PAYLOAD))
        self.assertNotEqual(base, sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD + " "))

    def test_sign_with_empty_secret_raises(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            sign("whsec_", id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        with self.assertRaises(WebhookVerificationError):
            sign("", id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)


class VerifyRoundTripTests(unittest.TestCase):
    def _sig(self, secret: str = SECRET) -> str:
        return sign(secret, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)

    def test_round_trip_passes(self) -> None:
        # verify returns None on success (no exception).
        self.assertIsNone(
            verify(
                SECRET,
                id=MSG_ID,
                timestamp=TIMESTAMP,
                signature=self._sig(),
                payload=PAYLOAD,
                now=TIMESTAMP,
            )
        )

    def test_round_trip_accepts_string_timestamp(self) -> None:
        verify(
            SECRET,
            id=MSG_ID,
            timestamp=str(TIMESTAMP),
            signature=self._sig(),
            payload=PAYLOAD,
            now=TIMESTAMP,
        )

    def test_tampered_payload_is_rejected(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            verify(
                SECRET,
                id=MSG_ID,
                timestamp=TIMESTAMP,
                signature=self._sig(),
                payload=PAYLOAD + "tampered",
                now=TIMESTAMP,
            )

    def test_wrong_secret_is_rejected(self) -> None:
        other = generate_secret()
        with self.assertRaises(WebhookVerificationError):
            verify(
                other,
                id=MSG_ID,
                timestamp=TIMESTAMP,
                signature=self._sig(),
                payload=PAYLOAD,
                now=TIMESTAMP,
            )

    def test_invalid_timestamp_header_raises(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            verify(
                SECRET,
                id=MSG_ID,
                timestamp="not-a-number",
                signature=self._sig(),
                payload=PAYLOAD,
                now=TIMESTAMP,
            )

    def test_no_matching_signature_raises(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            verify(
                SECRET,
                id=MSG_ID,
                timestamp=TIMESTAMP,
                signature="v1,bm90LXRoZS1yaWdodC1kaWdlc3Q=",
                payload=PAYLOAD,
                now=TIMESTAMP,
            )


class ToleranceWindowTests(unittest.TestCase):
    def _sig(self) -> str:
        return sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)

    def _verify_at(self, now: int, tolerance: int = 300) -> None:
        verify(
            SECRET,
            id=MSG_ID,
            timestamp=TIMESTAMP,
            signature=self._sig(),
            payload=PAYLOAD,
            tolerance_seconds=tolerance,
            now=now,
        )

    def test_within_window_passes(self) -> None:
        self._verify_at(TIMESTAMP)
        self._verify_at(TIMESTAMP + 300)  # exactly at the upper edge
        self._verify_at(TIMESTAMP - 300)  # exactly at the lower edge

    def test_too_old_is_rejected(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            self._verify_at(TIMESTAMP + 301)

    def test_too_new_is_rejected(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            self._verify_at(TIMESTAMP - 301)


class MultiTokenRotationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.secret_a = generate_secret()
        self.secret_b = generate_secret()
        self.sig_a = sign(self.secret_a, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        self.sig_b = sign(self.secret_b, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        self.header = f"{self.sig_a} {self.sig_b}"

    def _verify(self, secret: str) -> None:
        verify(
            secret,
            id=MSG_ID,
            timestamp=TIMESTAMP,
            signature=self.header,
            payload=PAYLOAD,
            now=TIMESTAMP,
        )

    def test_matches_either_rotated_secret(self) -> None:
        self._verify(self.secret_a)  # first token
        self._verify(self.secret_b)  # second token

    def test_unrelated_secret_still_rejected(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            self._verify(generate_secret())

    def test_malformed_and_unknown_version_tokens_are_skipped(self) -> None:
        # A token with no comma, an unknown version, and extra whitespace are all ignored;
        # the trailing valid v1 token still matches.
        header = f"garbage v2,YWJj   {self.sig_a}"
        verify(
            self.secret_a,
            id=MSG_ID,
            timestamp=TIMESTAMP,
            signature=header,
            payload=PAYLOAD,
            now=TIMESTAMP,
        )


class VerifyWebhookTests(unittest.TestCase):
    def _headers(self, **overrides: str) -> dict:
        sig = sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        headers = {
            "webhook-id": MSG_ID,
            "webhook-timestamp": str(TIMESTAMP),
            "webhook-signature": sig,
        }
        headers.update(overrides)
        return headers

    def test_passes_with_lowercase_headers(self) -> None:
        verify_webhook(SECRET, self._headers(), PAYLOAD, now=TIMESTAMP)

    def test_header_names_are_case_insensitive(self) -> None:
        sig = sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        mixed = {
            "Webhook-Id": MSG_ID,
            "Webhook-Timestamp": str(TIMESTAMP),
            "Webhook-Signature": sig,
        }
        verify_webhook(SECRET, mixed, PAYLOAD, now=TIMESTAMP)

    def test_missing_headers_raise(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(SECRET, {}, PAYLOAD, now=TIMESTAMP)
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(
                SECRET,
                {"webhook-id": MSG_ID, "webhook-timestamp": str(TIMESTAMP)},
                PAYLOAD,
                now=TIMESTAMP,
            )

    def test_is_valid_webhook_returns_bool(self) -> None:
        self.assertTrue(is_valid_webhook(SECRET, self._headers(), PAYLOAD, now=TIMESTAMP))
        self.assertFalse(is_valid_webhook(SECRET, self._headers(), PAYLOAD + "x", now=TIMESTAMP))
        self.assertFalse(is_valid_webhook(SECRET, {}, PAYLOAD, now=TIMESTAMP))


class GenerateSecretTests(unittest.TestCase):
    def test_format_and_uniqueness(self) -> None:
        a = generate_secret()
        b = generate_secret()
        self.assertTrue(a.startswith("whsec_"))
        self.assertNotEqual(a, b)

    def test_generated_secret_round_trips(self) -> None:
        secret = generate_secret()
        sig = sign(secret, id=MSG_ID, timestamp=TIMESTAMP, payload=PAYLOAD)
        verify(secret, id=MSG_ID, timestamp=TIMESTAMP, signature=sig, payload=PAYLOAD, now=TIMESTAMP)

    def test_rejects_short_length(self) -> None:
        with self.assertRaises(WebhookVerificationError):
            generate_secret(8)


if __name__ == "__main__":
    unittest.main()
