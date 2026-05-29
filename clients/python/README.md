# Posthorn Python SDK

The official Python client for [Posthorn](https://github.com/posthorn/posthorn) —
reliable, signed, observable webhook delivery. It is a zero-dependency port of the
TypeScript SDK with the same surface and wire contract: a producer can move between the
two without surprises.

- **Sending** — `PosthornClient`: send events, manage endpoints, read delivery status.
- **Receiving** — `verify_webhook`: verify the Standard Webhooks signature on an inbound
  delivery before you trust its body.
- **Zero dependencies** — Python standard library only (`urllib`, `hmac`, `hashlib`,
  `base64`, `secrets`). Python 3.9+.

## Install

```bash
pip install posthorn
```

Or vendor the `posthorn/` package directly — it has no third-party dependencies.

## Sending events

```python
from posthorn import PosthornClient

client = PosthornClient("https://posthorn.example", "your-api-key")

# Register a destination. The signing secret is returned exactly once — store it.
endpoint = client.create_endpoint(
    url="https://example.com/webhooks",
    event_types=["user.created"],
)
print("save this secret:", endpoint["secret"])

# Send an event; it fans out to every subscribed endpoint.
result = client.send_message(event_type="user.created", payload={"id": 123})
print(result["message"]["id"], result["fanout"])

# Observe what happened.
message = client.get_message(result["message"]["id"])
for delivery in message["deliveries"]:
    print(delivery["endpointId"], delivery["status"])
```

Methods return the gateway's JSON decoded into plain `dict`/`list` values. Optional
arguments are omitted from the request entirely unless you pass them; pass `None`
explicitly to send a JSON `null` (e.g. to clear an endpoint's channel on update).

### Errors

Every failure raises a subclass of `PosthornError`:

```python
from posthorn import PosthornApiError, PosthornTimeoutError

try:
    client.get_message("nonexistent")
except PosthornApiError as e:
    print(e.status, e.code)   # 404 not_found  — branch on the stable `code`
except PosthornTimeoutError:
    print("the request timed out")
```

## Receiving (verifying) webhooks

When Posthorn delivers an event to your endpoint, verify its signature against the raw
request body **before** parsing or trusting it. Use the secret from `create_endpoint`.

```python
from posthorn import verify_webhook, WebhookVerificationError

def handle(request):
    try:
        # Pass the raw body string exactly as received — verify before any JSON round-trip,
        # which can reorder keys / change whitespace and break the signature.
        verify_webhook(secret, request.headers, request.body)
    except WebhookVerificationError:
        return 400  # reject: bad signature, replay, or missing headers
    event = json.loads(request.body)
    ...
```

`is_valid_webhook(...)` is a boolean variant that returns `False` instead of raising on an
ordinary verification failure. `sign(...)` and `generate_secret(...)` are exposed too, so a
Python service can produce signatures the gateway (or another receiver) will accept.

## API surface

`PosthornClient` mirrors the TS SDK one-to-one. Messages: `send_message`,
`send_message_batch`, `list_messages`, `get_message`, `list_message_attempts`,
`retry_message`, `cancel_message`. Endpoints: `list_endpoints`, `create_endpoint`,
`get_endpoint`, `update_endpoint`, `delete_endpoint`, `list_endpoint_deliveries`,
`retry_endpoint_deliveries`, `replay_endpoint`, `get_endpoint_stats`,
`rotate_endpoint_secret`, `test_endpoint`. Deliveries: `list_deliveries`, `get_delivery`,
`list_delivery_attempts`, `retry_all_deliveries`. Plus `get_usage`, `create_portal_session`,
and the event-type catalog (`list_event_types`, `create_event_type`, `get_event_type`,
`update_event_type`, `archive_event_type`), and the `health` probe.

Each method maps to one documented OpenAPI operation (`posthorn.OPERATIONS`); that mapping
is tested against the live `/openapi.json` so the SDK cannot silently drift from the API.

## License

MIT.
