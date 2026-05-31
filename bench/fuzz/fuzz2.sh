#!/usr/bin/env bash
# Setup env variables and boot server
export POSTHORN_SIGNUP_ENABLED=true
export POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE=100
export POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true
export POSTHORN_ADMIN_API_KEY="admin_key"

kill $(lsof -t -i :3000) 2>/dev/null || true
sleep 1
npm start > npm_start_test.log 2>&1 &
sleep 2

# Create tenant
RES=$(curl -s -X POST http://127.0.0.1:3000/v1/signup -H "Content-Type: application/json" -d '{"name": "fuzz-tenant-2"}')
API_KEY=$(echo "$RES" | jq -r '.secret')

# XSS / SQLi payloads
echo "[*] Chaos Testing - Malicious Inputs..."
curl -s -X POST http://127.0.0.1:3000/v1/event-types \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "test.event", "name": "<script>alert(1)</script>"}'

curl -s -X POST http://127.0.0.1:3000/v1/event-types \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "test.event2", "name": "'; DROP TABLE apps; --"}'

curl -s -X POST http://127.0.0.1:3000/v1/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://127.0.0.1:8080/webhook", "eventTypes": ["test.event", "'; DROP TABLE apps; --"]}'

# Very long Event ID
LONG_EVENT=$(python -c "print('A'*10000)")
curl -s -X POST http://127.0.0.1:3000/v1/event-types \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$LONG_EVENT\", \"name\": \"Test Event\"}"

# Empty string URL
curl -s -X POST http://127.0.0.1:3000/v1/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "", "eventTypes": ["test.event"]}'

# Missing content-type
curl -s -X POST http://127.0.0.1:3000/v1/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"url": "http://127.0.0.1:8080/webhook", "eventTypes": ["test.event"]}'

sleep 2
echo "Stopping server"
kill $(lsof -t -i :3000) 2>/dev/null || true
