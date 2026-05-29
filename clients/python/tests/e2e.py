"""Live end-to-end smoke for the Posthorn Python SDK.

Driven by ``scripts/smoke-python-sdk.mjs``: the Node harness boots the dist gateway,
mints a tenant key via ``POST /v1/signup``, starts a local 127.0.0.1 HTTP sink that 200s
every request, and runs this script with the environment below. Standalone-running is not
supported (it needs a live gateway); the unit suites in this directory are the offline tests.

Environment:
  POSTHORN_URL, POSTHORN_API_KEY              the live gateway + tenant key
  POSTHORN_SINK_URL                           a local sink endpoint URL (200s everything)
  POSTHORN_INTEROP_{SECRET,ID,TS,PAYLOAD,SIG} a Node-produced Standard Webhooks vector

It (1) exercises ``PosthornClient`` against the real HTTP surface, (2) asserts the
``OPERATIONS`` map exactly partitions the live ``/openapi.json`` operations (the drift
guard), and (3) cross-checks Standard Webhooks signing both directions. On success it
prints ``PY_INTEROP_SIG=<token>`` (for the harness to verify back in Node) and a final
``PY_SDK_E2E_PASS n/n``.
"""

import json
import os
import sys
import urllib.request

from posthorn import (
    EXCLUDED_OPERATIONS,
    OPERATIONS,
    PosthornApiError,
    PosthornClient,
    WebhookVerificationError,
    sign,
    verify_webhook,
)

_passed = 0


def check(label: str, cond: bool) -> None:
    global _passed
    if not cond:
        print(f"FAIL: {label}", file=sys.stderr)
        sys.exit(1)
    print(f"✓ {label}")
    _passed += 1


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"FAIL: missing required env {name}", file=sys.stderr)
        sys.exit(1)
    return value


base_url = env("POSTHORN_URL")
api_key = env("POSTHORN_API_KEY")
sink_url = env("POSTHORN_SINK_URL")

client = PosthornClient(base_url, api_key)

# ── Operational ──────────────────────────────────────────────────────────────────
health = client.health()
check("health() returns a status", isinstance(health, dict) and "status" in health)

# ── Endpoints CRUD ───────────────────────────────────────────────────────────────
created = client.create_endpoint(
    url=sink_url, event_types=["user.created"], description="py e2e"
)
check(
    "create_endpoint returns the once-shown secret",
    isinstance(created.get("secret"), str) and created["url"] == sink_url,
)
ep_id = created["id"]
first_secret = created["secret"]

eps = client.list_endpoints()
check(
    "list_endpoints returns an unwrapped array containing the endpoint",
    isinstance(eps, list) and any(e["id"] == ep_id for e in eps),
)

check("get_endpoint matches", client.get_endpoint(ep_id)["id"] == ep_id)

check(
    "update_endpoint applies the patch",
    client.update_endpoint(ep_id, description="updated")["description"] == "updated",
)

rotated = client.rotate_endpoint_secret(ep_id)
check(
    "rotate_endpoint_secret returns a fresh once-shown secret",
    isinstance(rotated.get("secret"), str) and rotated["secret"] != first_secret,
)

# Synchronous test delivery to the local sink — proves end-to-end signing + HTTP without
# depending on the async worker (the test path delivers inline and returns the result).
test_res = client.test_endpoint(ep_id, payload={"hello": "world"})
check(
    "test_endpoint succeeds against the local sink",
    test_res.get("success") is True and test_res.get("httpStatus") == 200,
)

stats = client.get_endpoint_stats(ep_id, days=7)
check("get_endpoint_stats returns totals + a daily breakdown", "total" in stats and "daily" in stats)

epd = client.list_endpoint_deliveries(ep_id)
check("list_endpoint_deliveries returns a page", "data" in epd and "nextCursor" in epd)

# ── Messages ─────────────────────────────────────────────────────────────────────
sent = client.send_message(event_type="user.created", payload={"id": 1}, idempotency_key="py-e2e-1")
check(
    "send_message is accepted and fans out to the 1 subscribed endpoint",
    sent["message"]["eventType"] == "user.created" and sent["fanout"]["matched"] == 1,
)
msg_id = sent["message"]["id"]

again = client.send_message(event_type="user.created", payload={"id": 1}, idempotency_key="py-e2e-1")
check("send_message with a repeated idempotency key deduplicates", again["deduplicated"] is True)

msg = client.get_message(msg_id)
check(
    "get_message returns the message and its one delivery",
    msg["id"] == msg_id and len(msg["deliveries"]) == 1,
)

attempts = client.list_message_attempts(msg_id)
check("list_message_attempts returns a page", "data" in attempts and "nextCursor" in attempts)

page = client.list_messages(limit=10)
check("list_messages includes our message", any(m["id"] == msg_id for m in page["data"]))

batch = client.send_message_batch(
    [
        {"event_type": "user.created", "payload": {"n": 1}},
        {"event_type": "user.created", "payload": {"n": 2}},
    ]
)
check(
    "send_message_batch returns one result per item",
    len(batch["results"]) == 2 and all("ok" in r for r in batch["results"]),
)

# ── Deliveries ───────────────────────────────────────────────────────────────────
deliveries = client.list_deliveries()
check(
    "list_deliveries returns a page with our delivery",
    "nextCursor" in deliveries and len(deliveries["data"]) >= 1,
)
delivery_id = deliveries["data"][0]["id"]
check("get_delivery returns the delivery", client.get_delivery(delivery_id)["id"] == delivery_id)
da = client.list_delivery_attempts(delivery_id)
check("list_delivery_attempts returns a page", "data" in da and "nextCursor" in da)

bulk = client.retry_all_deliveries()
check("retry_all_deliveries returns a tally", "retried" in bulk and "hasMore" in bulk)
ep_bulk = client.retry_endpoint_deliveries(ep_id)
check("retry_endpoint_deliveries returns a tally", "retried" in ep_bulk and "hasMore" in ep_bulk)

cancelled = client.cancel_message(msg_id)
check("cancel_message returns refreshed deliveries", cancelled["id"] == msg_id and "deliveries" in cancelled)
retried = client.retry_message(msg_id)
check("retry_message returns refreshed deliveries", retried["id"] == msg_id and "deliveries" in retried)

replay = client.replay_endpoint(ep_id, limit=10)
check("replay_endpoint returns a tally", "enqueued" in replay and "hasMore" in replay)

# ── Usage, portal, event types ─────────────────────────────────────────────────────
usage = client.get_usage()
check("get_usage returns totals + a live quota block", "quota" in usage and "total" in usage)

portal = client.create_portal_session(external_user_id="user-123")
check(
    "create_portal_session returns a token + redirect URL",
    isinstance(portal.get("token"), str) and isinstance(portal.get("portalUrl"), str),
)

et = client.create_event_type(id="user.created", name="User Created", description="desc")
check("create_event_type", et["id"] == "user.created" and et["name"] == "User Created")
check(
    "list_event_types includes the new type",
    any(t["id"] == "user.created" for t in client.list_event_types()["data"]),
)
check("get_event_type matches", client.get_event_type("user.created")["id"] == "user.created")
check(
    "update_event_type applies the patch",
    client.update_event_type("user.created", name="Renamed")["name"] == "Renamed",
)
client.archive_event_type("user.created")
check("archive_event_type returns None", True)

# ── Error model ────────────────────────────────────────────────────────────────────
try:
    client.get_message("nonexistent")
    check("get_message(nonexistent) raises", False)
except PosthornApiError as exc:
    check("a 404 maps to PosthornApiError with status + code", exc.status == 404 and isinstance(exc.code, str))

client.delete_endpoint(ep_id)
try:
    client.get_endpoint(ep_id)
    check("get_endpoint(deleted) raises", False)
except PosthornApiError as exc:
    check("delete_endpoint took effect (subsequent get → 404)", exc.status == 404)

# ── OpenAPI drift guard: OPERATIONS ⊎ EXCLUDED_OPERATIONS == live spec operations ────
with urllib.request.urlopen(base_url + "/openapi.json", timeout=10) as resp:
    spec = json.loads(resp.read())
spec_ops = {
    op["operationId"]
    for item in spec["paths"].values()
    for op in item.values()
    if isinstance(op, dict) and "operationId" in op
}
mapped = set(OPERATIONS)
excluded = set(EXCLUDED_OPERATIONS)
check("OPERATIONS and EXCLUDED_OPERATIONS are disjoint", mapped.isdisjoint(excluded))
only_spec = spec_ops - (mapped | excluded)
only_local = (mapped | excluded) - spec_ops
if only_spec or only_local:
    print(f"  spec-only: {sorted(only_spec)}  local-only: {sorted(only_local)}", file=sys.stderr)
check("OPERATIONS ∪ EXCLUDED_OPERATIONS exactly equals the live spec operations", not only_spec and not only_local)
check(
    "every mapped operation names a real, callable client method",
    all(callable(getattr(client, method, None)) for method in OPERATIONS.values()),
)

# ── Signature interop: Node ↔ Python ────────────────────────────────────────────────
isecret = env("POSTHORN_INTEROP_SECRET")
iid = env("POSTHORN_INTEROP_ID")
its = int(env("POSTHORN_INTEROP_TS"))
ipayload = env("POSTHORN_INTEROP_PAYLOAD")
node_sig = env("POSTHORN_INTEROP_SIG")

interop_headers = {"webhook-id": iid, "webhook-timestamp": str(its), "webhook-signature": node_sig}
verify_webhook(isecret, interop_headers, ipayload, now=its)
check("a Node-signed webhook verifies in Python", True)

tampered_rejected = False
try:
    verify_webhook(isecret, interop_headers, ipayload + "X", now=its)
except WebhookVerificationError:
    tampered_rejected = True
check("Python rejects a tampered Node-signed webhook", tampered_rejected)

py_sig = sign(isecret, id=iid, timestamp=its, payload=ipayload)
check("Python's signature is byte-for-byte identical to Node's", py_sig == node_sig)
print(f"PY_INTEROP_SIG={py_sig}")

print(f"\nPY_SDK_E2E_PASS {_passed}/{_passed}")
