#!/usr/bin/env bash
export POSTHORN_SIGNUP_ENABLED=true
export POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE=100
export POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true

kill $(lsof -t -i :3000) 2>/dev/null || true
sleep 1
npm start > npm_start_test.log 2>&1 &
sleep 2

RES=$(curl -s -X POST http://127.0.0.1:3000/v1/signup -H "Content-Type: application/json" -d '{"name": "fuzz-tenant-http"}')
API_KEY=$(echo "$RES" | jq -r '.secret')
APP_ID=$(echo "$RES" | jq -r '.app.id')

# Invalid authentication
curl -s -X GET http://127.0.0.1:3000/v1/endpoints -H "Authorization: Bearer invalid_key"
# Missing Authorization header
curl -s -X GET http://127.0.0.1:3000/v1/endpoints
# Valid authentication, but wrong token type
curl -s -X GET http://127.0.0.1:3000/v1/endpoints -H "Authorization: Basic $API_KEY"

# Send very large batch of messages
PAYLOAD="{\"messages\": ["
for i in {1..101}; do
  PAYLOAD+="{\"eventType\": \"test.event\", \"payload\": {\"id\": $i}}"
  if [ $i -ne 101 ]; then PAYLOAD+=", "; fi
done
PAYLOAD+="]}"
echo "$PAYLOAD" | curl -s -X POST http://127.0.0.1:3000/v1/messages/batch \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @-

# Pagination with extreme offets
curl -s -X GET "http://127.0.0.1:3000/v1/messages?limit=50&after=cursor_does_not_exist" -H "Authorization: Bearer $API_KEY"

sleep 2
kill $(lsof -t -i :3000) 2>/dev/null || true
