"""Transport and error model for the Posthorn Python SDK.

This is the Python counterpart of the TypeScript SDK's ``src/sdk/http.ts``: a thin,
dependency-free wrapper over ``urllib`` that adds bearer auth, JSON encode/decode, a
per-request timeout, and the gateway's ``{"error": {"code", "message"}}`` failure
envelope mapped onto typed exceptions. It speaks the exact same wire contract, so a
producer can move between the two SDKs without surprises.

Zero third-party dependencies: only the Python standard library is used.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

DEFAULT_TIMEOUT_SECONDS = 30.0


class PosthornError(Exception):
    """Base class for every error raised by the SDK."""


class PosthornApiError(PosthornError):
    """A non-2xx response from the gateway.

    Carries the HTTP ``status`` and the machine-readable ``code`` from the API's
    ``{"error": {"code", "message"}}`` envelope (e.g. ``"not_found"``,
    ``"quota_exceeded"``, ``"rate_limited"``), so callers can branch on a stable
    string rather than parsing the human message.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"API error {self.status} ({self.code}): {super().__str__()}"


class PosthornTimeoutError(PosthornError):
    """A request exceeded the configured per-request timeout."""


class _Transport:
    """Issues authenticated JSON requests against a gateway base URL."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not isinstance(base_url, str) or base_url.strip() == "":
            raise ValueError("base_url must be a non-empty string")
        if not isinstance(api_key, str) or api_key == "":
            raise ValueError("api_key must be a non-empty string")
        # Tolerate (and strip) a trailing slash so join is unambiguous, matching the
        # TS client. Paths passed to request() always begin with "/".
        self._base = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout

    def request(self, method: str, path: str, body: Any | None = None) -> Any:
        """Issue one request and return the decoded JSON (or ``None`` for 204/empty).

        Raises :class:`PosthornApiError` on a non-2xx response, :class:`PosthornTimeoutError`
        on a timeout, and :class:`PosthornError` on a transport-level failure.
        """
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self._base + path, data=data, method=method)
        req.add_header("authorization", f"Bearer {self._api_key}")
        req.add_header("accept", "application/json")
        if data is not None:
            req.add_header("content-type", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as err:
            # A non-2xx response: urllib raises, but the body carries our error envelope.
            raw = err.read()
            text = raw.decode("utf-8", "replace") if raw else ""
            raise _to_api_error(err.code, text) from None
        except socket.timeout:
            raise PosthornTimeoutError(
                f"request {method} {path} timed out after {self._timeout}s"
            ) from None
        except urllib.error.URLError as err:
            if isinstance(err.reason, socket.timeout):
                raise PosthornTimeoutError(
                    f"request {method} {path} timed out after {self._timeout}s"
                ) from None
            raise PosthornError(f"network error issuing {method} {path}: {err.reason}") from err

        if status == 204 or not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as err:
            raise PosthornError(
                f"failed to parse {method} {path} response as JSON: {err}"
            ) from err


def _to_api_error(status: int, text: str) -> PosthornApiError:
    """Map a non-2xx response into a :class:`PosthornApiError`, reading the envelope."""
    code = f"http_{status}"
    message = text if text else f"request failed with status {status}"
    if text:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
            err = parsed["error"]
            if isinstance(err.get("code"), str):
                code = err["code"]
            if isinstance(err.get("message"), str):
                message = err["message"]
    return PosthornApiError(status, code, message)
