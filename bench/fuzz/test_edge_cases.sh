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

RES=$(curl -s -X POST http://127.0.0.1:3000/v1/signup -H "Content-Type: application/json" -d '{"name": "fuzz-tenant-4"}')
API_KEY=$(echo "$RES" | jq -r '.secret')
APP_ID=$(echo "$RES" | jq -r '.app.id')


echo "[*] Testing endpoint limits"
curl -s -X POST http://127.0.0.1:3000/v1/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://127.0.0.1:8080/webhook", "eventTypes": ["test.event"], "rateLimit": -1}'

curl -s -X POST http://127.0.0.1:3000/v1/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://127.0.0.1:8080/webhook", "eventTypes": ["test.event"], "rateLimit": 10001}'


echo "[*] Testing API keys revocation limit"
KEY_RES=$(curl -s -X POST http://127.0.0.1:3000/v1/admin/apps/$APP_ID/keys -H "Authorization: Bearer admin_key")
KEY_ID=$(echo $KEY_RES | jq -r '.apiKey.id')

# Revoke multiple times
curl -s -X POST http://127.0.0.1:3000/v1/admin/keys/$KEY_ID/revoke -H "Authorization: Bearer admin_key"
curl -s -X POST http://127.0.0.1:3000/v1/admin/keys/$KEY_ID/revoke -H "Authorization: Bearer admin_key"


echo "[*] Testing portal session creation"
curl -s -X POST http://127.0.0.1:3000/v1/portal/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalUserId": "user_123", "expiresIn": 0}'

curl -s -X POST http://127.0.0.1:3000/v1/portal/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalUserId": "user_123", "expiresIn": 604801}'

sleep 2
kill $(lsof -t -i :3000) 2>/dev/null || true
