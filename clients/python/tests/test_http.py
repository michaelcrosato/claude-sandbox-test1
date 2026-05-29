"""Unit tests for :mod:`posthorn._http` — the transport's pure pieces.

The request path itself (sockets, timeouts) is exercised against a live gateway in the
e2e smoke; here we pin the error-envelope mapping and constructor validation, which are
pure and stdlib-testable.
"""

import unittest

from posthorn import PosthornApiError
from posthorn._http import _Transport, _to_api_error


class ToApiErrorTests(unittest.TestCase):
    def test_reads_code_and_message_from_envelope(self) -> None:
        err = _to_api_error(404, '{"error":{"code":"not_found","message":"no such message"}}')
        self.assertIsInstance(err, PosthornApiError)
        self.assertEqual(err.status, 404)
        self.assertEqual(err.code, "not_found")
        self.assertEqual(str(err), "API error 404 (not_found): no such message")

    def test_empty_body_falls_back_to_status(self) -> None:
        err = _to_api_error(500, "")
        self.assertEqual(err.code, "http_500")
        self.assertEqual(err.args[0], "request failed with status 500")

    def test_non_json_body_is_used_verbatim(self) -> None:
        err = _to_api_error(502, "upstream exploded")
        self.assertEqual(err.code, "http_502")
        self.assertEqual(err.args[0], "upstream exploded")

    def test_envelope_without_code_keeps_default_code(self) -> None:
        err = _to_api_error(400, '{"error":{"message":"bad input"}}')
        self.assertEqual(err.code, "http_400")
        self.assertEqual(err.args[0], "bad input")

    def test_envelope_without_message_keeps_body_text(self) -> None:
        body = '{"error":{"code":"weird"}}'
        err = _to_api_error(400, body)
        self.assertEqual(err.code, "weird")
        self.assertEqual(err.args[0], body)


class TransportConstructorTests(unittest.TestCase):
    def test_rejects_empty_base_url(self) -> None:
        with self.assertRaises(ValueError):
            _Transport("", "key")
        with self.assertRaises(ValueError):
            _Transport("   ", "key")

    def test_rejects_empty_api_key(self) -> None:
        with self.assertRaises(ValueError):
            _Transport("https://x", "")

    def test_strips_trailing_slash(self) -> None:
        t = _Transport("https://posthorn.example/", "key")
        self.assertEqual(t._base, "https://posthorn.example")


if __name__ == "__main__":
    unittest.main()
