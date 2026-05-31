#!/usr/bin/env bash

# Setup env variables and boot server
export POSTHORN_SIGNUP_ENABLED=true
export POSTHORN_SIGNUP_RATE_LIMIT_PER_MINUTE=100
export POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true
export POSTHORN_ADMIN_API_KEY="admin_key"

# Kill running server just in case
kill $(lsof -t -i :3000) 2>/dev/null || true
sleep 1
npm start > npm_start_test.log 2>&1 &
sleep 2

echo "[*] Fuzzing Admin Routes..."
curl -s -X POST http://127.0.0.1:3000/v1/admin/apps \
  -H "Authorization: Bearer admin_key" \
  -H "Content-Type: application/json" \
  -d '{"name": "fuzz-tenant-admin"}'

RES=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X GET http://127.0.0.1:3000/v1/admin/apps \
  -H "Authorization: Bearer admin_key")
APP_ID=$(echo "$RES" | grep -v HTTP_STATUS | jq -r '.data[0].id')
echo "Admin App ID: $APP_ID"

curl -s -X POST "http://127.0.0.1:3000/v1/admin/apps/${APP_ID}/keys" \
  -H "Authorization: Bearer admin_key"

echo "[*] Chaos Testing - Bad inputs..."
# Garbage JSON
curl -s -X POST http://127.0.0.1:3000/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"name": '
# Huge payload
dd if=/dev/urandom bs=1M count=10 | base64 | curl -s -X POST http://127.0.0.1:3000/v1/signup -H "Content-Type: application/json" --data-binary @-
# Extremely long URL
curl -s -X GET "http://127.0.0.1:3000/$(python -c "print('A'*10000)")"
# Invalid HTTP method
curl -s -X PUT http://127.0.0.1:3000/v1/signup -H "Content-Type: application/json" -d '{"name": "test"}'

sleep 2
echo "Stopping server"
kill $(lsof -t -i :3000) 2>/dev/null || true
