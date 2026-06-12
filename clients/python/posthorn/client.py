from __future__ import annotations

import json
from typing import Any, Dict, Iterable, Mapping, Optional
from urllib import error, parse, request


class PosthornError(Exception):
    """Base class for Posthorn SDK errors."""


class PosthornApiError(PosthornError):
    def __init__(self, status: int, code: str, message: str, body: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.body = body
        self.response_body = body


class PosthornClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 10.0) -> None:
        self.base_url = _normalize_base_url(base_url)
        self.api_key = _require_non_empty(api_key, "api_key")
        self.timeout = timeout

    def create_endpoint(
        self,
        url: str,
        event_types: Optional[Iterable[str]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"url": url}
        if event_types is not None:
            body["eventTypes"] = list(event_types)
        if headers is not None:
            body["headers"] = dict(headers)
        return self._request("POST", "/v1/endpoints", body)

    def list_endpoints(self) -> list:
        return self._request("GET", "/v1/endpoints")["data"]

    def send_message(
        self,
        event_type: str,
        payload: Any,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"eventType": event_type, "payload": payload}
        if idempotency_key is not None:
            body["idempotencyKey"] = idempotency_key
        return self._request("POST", "/v1/messages", body)

    def send_message_batch(self, items: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
        return self._request("POST", "/v1/messages/batch", [dict(item) for item in items])

    def get_message(self, message_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/messages/{_path_segment(message_id)}")

    def retry_message(self, message_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/v1/messages/{_path_segment(message_id)}/retry")

    def list_message_attempts(
        self,
        message_id: str,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "GET",
            f"/v1/messages/{_path_segment(message_id)}/attempts{_query(limit=limit, cursor=cursor)}",
        )

    def get_usage(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/usage")

    def list_endpoint_deliveries(
        self,
        endpoint_id: str,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "GET",
            f"/v1/endpoints/{_path_segment(endpoint_id)}/deliveries{_query(limit=limit, cursor=cursor)}",
        )

    def get_endpoint_stats(self, endpoint_id: str, days: Optional[int] = None) -> Dict[str, Any]:
        return self._request(
            "GET",
            f"/v1/endpoints/{_path_segment(endpoint_id)}/stats{_query(days=days)}",
        )

    def list_deliveries(
        self,
        status: Optional[str] = None,
        endpoint_id: Optional[str] = None,
        event_type: Optional[str] = None,
        failure_reason: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "GET",
            "/v1/deliveries"
            + _query(
                status=status,
                endpointId=endpoint_id,
                eventType=event_type,
                failureReason=failure_reason,
                limit=limit,
                cursor=cursor,
            ),
        )

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")

        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                status = response.status
                payload = response.read()
                if status == 204:
                    return None
                parsed = _parse_response(payload)
                if 200 <= status <= 299:
                    return parsed
                raise _api_error(status, parsed)
        except error.HTTPError as exc:
            payload = exc.read()
            parsed = _parse_response(payload)
            raise _api_error(exc.code, parsed) from None
        except PosthornApiError:
            raise
        except Exception as exc:
            raise PosthornError(str(exc)) from exc


def _normalize_base_url(value: str) -> str:
    value = _require_non_empty(value, "base_url").rstrip("/")
    parsed = parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("base_url must be an absolute HTTP(S) URL.")
    return value


def _require_non_empty(value: str, name: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"{name} must be a non-empty string.")
    return value.strip()


def _path_segment(value: str) -> str:
    return parse.quote(_require_non_empty(value, "id"), safe="")


def _query(**params: Any) -> str:
    clean = {key: value for key, value in params.items() if value is not None}
    if not clean:
        return ""
    return "?" + parse.urlencode(clean)


def _parse_response(payload: bytes) -> Any:
    if payload.strip() == b"":
        return None
    text = payload.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _api_error(status: int, body: Any) -> PosthornApiError:
    if isinstance(body, dict):
        envelope = body.get("error")
        if isinstance(envelope, dict):
            code = envelope.get("code")
            message = envelope.get("message")
            if isinstance(code, str) and isinstance(message, str):
                return PosthornApiError(status, code, message, body)
    return PosthornApiError(status, "http_error", f"HTTP {status} from Posthorn API.", body)
