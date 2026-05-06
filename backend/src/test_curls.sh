#!/bin/bash
BASE_URL="http://127.0.0.1:4000/api"

echo "--- Industrial API Manual Verification ---"

# 1. Login
echo "[1/6] Testing Login..."
LOGIN_RES=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin", "password":"admin"}')
TOKEN=$(echo $LOGIN_RES | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -n "$TOKEN" ]; then
    echo "✅ Login Successful"
else
    echo "❌ Login Failed: $LOGIN_RES"
    exit 1
fi

AUTH_H="Authorization: Bearer $TOKEN"

# 2. Tenants (Key is "id")
echo "[2/6] Testing Tenants..."
curl -s -X GET "$BASE_URL/admin/tenants" -H "$AUTH_H" | grep -q "\"id\":" && echo "✅ Tenants API OK" || echo "❌ Tenants API Failed"

# 3. Users
echo "[3/6] Testing Users..."
curl -s -X GET "$BASE_URL/admin/users" -H "$AUTH_H" | grep -q "\"username\":" && echo "✅ Users API OK" || echo "❌ Users API Failed"

# 4. Catalog
echo "[4/6] Testing Catalog..."
curl -s -X GET "$BASE_URL/admin/catalog" -H "$AUTH_H" | grep -q "\"table_name\":" && echo "✅ Catalog API OK" || echo "❌ Catalog API Failed"

# 5. Audit Logs
echo "[5/6] Testing Audit Logs..."
curl -s -X GET "$BASE_URL/admin/audit-logs" -H "$AUTH_H" | grep -q "\"action\":" && echo "✅ Audit Logs API OK" || echo "❌ Audit Logs API Failed"

# 6. Query Exec
echo "[6/6] Testing Query Exec..."
QUERY_RES=$(curl -s -X POST "$BASE_URL/queries/exec" \
  -H "$AUTH_H" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT 1 as result"}')
echo $QUERY_RES | grep -q "\"result\":1" && echo "✅ Query Exec API OK" || echo "❌ Query Exec API Failed: $QUERY_RES"

echo "--- ALL APIs VERIFIED MANUALLY ---"
