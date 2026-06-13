# Posthorn Python SDK

Dependency-free Python 3.9+ client for Posthorn.

```python
from posthorn import PosthornClient, PosthornApiError, verify_webhook

client = PosthornClient("https://posthorn.example.com", "phk_...")

endpoint = client.create_endpoint(
    url="https://acme.example/webhooks/posthorn",
    event_types=["user.created"],
    rate_limit_per_second=10,
)

sent = client.send_message(
    event_type="user.created",
    payload={"id": 42},
    idempotency_key="req_42",
    deduplication_key="user.created:42",
    deduplication_window_seconds=3600,
)

attempts = client.list_message_attempts(sent["message"]["id"], limit=25)
deliveries = client.list_deliveries(status="dead_letter", limit=25)
usage = client.get_usage()

try:
    client.create_endpoint("http://127.0.0.1/private")
except PosthornApiError as exc:
    assert exc.status == 400
    assert exc.code == "url_not_allowed"

verify_webhook(endpoint["secret"], request.headers, raw_body)
```

For local development without publishing a package, point `PYTHONPATH` at this directory:

```bash
PYTHONPATH=clients/python python -c "from posthorn import PosthornClient; print(PosthornClient)"
```
