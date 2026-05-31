#!/usr/bin/env bash
export POSTHORN_SIGNUP_ENABLED=true
export POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE=100
export POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true
export POSTHORN_ADMIN_API_KEY="admin_key"

kill $(lsof -t -i :3000) 2>/dev/null || true
sleep 1
npm start > npm_start_test.log 2>&1 &
sleep 2

RES=$(curl -s -X POST http://127.0.0.1:3000/v1/signup -H "Content-Type: application/json" -d '{"name": "fuzz-tenant-4"}')
API_KEY=$(echo "$RES" | jq -r '.secret')
APP_ID=$(echo "$RES" | jq -r '.app.id')

PAYLOAD1=$(cat << 'PAYLOAD'
{"id": "test.event2", "name": "test'; DROP TABLE apps; --"}
PAYLOAD
)
# Try SQLi properly
curl -s -X POST http://127.0.0.1:3000/v1/event-types \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD1"

# Test messages schema
curl -s -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eventType": "test.event2", "payload": {"foo": "bar"}}'

# Let's try directory traversal on API endpoints
curl -s -X GET "http://127.0.0.1:3000/v1/endpoints/../../../etc/passwd" -H "Authorization: Bearer $API_KEY"

# Send negative pagination limits
curl -s -X GET "http://127.0.0.1:3000/v1/messages?limit=-10" \
  -H "Authorization: Bearer $API_KEY"

curl -s -X GET "http://127.0.0.1:3000/v1/messages?limit=1000000" \
  -H "Authorization: Bearer $API_KEY"

sleep 2
kill $(lsof -t -i :3000) 2>/dev/null || true
