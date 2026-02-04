#!/bin/bash

# Script per testare la configurazione CORS del backend Studio Cantini
# Usage: ./test-cors.sh <backend-url> <frontend-origin>

BACKEND_URL=${1:-"http://localhost:9000"}
FRONTEND_ORIGIN=${2:-"http://localhost:3000"}

echo "======================================"
echo "Test Configurazione CORS"
echo "======================================"
echo "Backend URL: $BACKEND_URL"
echo "Frontend Origin: $FRONTEND_ORIGIN"
echo "======================================"
echo ""

# Test 1: Health check
echo "1. Test Health Check..."
HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$BACKEND_URL/health")
if [ "$HEALTH_RESPONSE" = "200" ]; then
    echo "   ✅ Backend is running (HTTP $HEALTH_RESPONSE)"
else
    echo "   ❌ Backend is not responding correctly (HTTP $HEALTH_RESPONSE)"
    exit 1
fi
echo ""

# Test 2: CORS preflight request
echo "2. Test CORS Preflight (OPTIONS)..."
CORS_RESPONSE=$(curl -s -i -X OPTIONS \
    -H "Origin: $FRONTEND_ORIGIN" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type, Authorization" \
    "$BACKEND_URL/v1/auth/login")

echo "$CORS_RESPONSE" | grep -i "Access-Control-Allow-Origin"
echo "$CORS_RESPONSE" | grep -i "Access-Control-Allow-Methods"
echo "$CORS_RESPONSE" | grep -i "Access-Control-Allow-Headers"
echo "$CORS_RESPONSE" | grep -i "Access-Control-Allow-Credentials"

if echo "$CORS_RESPONSE" | grep -q "Access-Control-Allow-Origin"; then
    echo "   ✅ CORS headers present"
else
    echo "   ❌ CORS headers missing"
    echo ""
    echo "Full response:"
    echo "$CORS_RESPONSE"
    exit 1
fi
echo ""

# Test 3: Verify specific origin is allowed
echo "3. Verify origin is allowed..."
if echo "$CORS_RESPONSE" | grep -q "Access-Control-Allow-Origin: $FRONTEND_ORIGIN"; then
    echo "   ✅ Origin $FRONTEND_ORIGIN is allowed"
elif echo "$CORS_RESPONSE" | grep -q "Access-Control-Allow-Origin: \*"; then
    echo "   ⚠️  Warning: All origins are allowed (not recommended for production)"
else
    echo "   ❌ Origin $FRONTEND_ORIGIN is NOT allowed"
    exit 1
fi
echo ""

# Test 4: Test actual POST request
echo "4. Test POST request with CORS..."
POST_RESPONSE=$(curl -s -i -X POST \
    -H "Origin: $FRONTEND_ORIGIN" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-token" \
    -d '{"username":"test","password":"test"}' \
    "$BACKEND_URL/v1/auth/login")

if echo "$POST_RESPONSE" | grep -q "Access-Control-Allow-Origin"; then
    echo "   ✅ CORS headers present in POST response"
else
    echo "   ❌ CORS headers missing in POST response"
fi
echo ""

# Test multiple origins if provided
if [ -n "$3" ]; then
    echo "5. Test additional origin: $3..."
    ADDITIONAL_CORS_RESPONSE=$(curl -s -i -X OPTIONS \
        -H "Origin: $3" \
        -H "Access-Control-Request-Method: POST" \
        -H "Access-Control-Request-Headers: Content-Type" \
        "$BACKEND_URL/v1/auth/login")
    
    if echo "$ADDITIONAL_CORS_RESPONSE" | grep -q "Access-Control-Allow-Origin"; then
        echo "   ✅ Origin $3 is allowed"
    else
        echo "   ❌ Origin $3 is NOT allowed"
    fi
    echo ""
fi

echo "======================================"
echo "Test completato!"
echo "======================================"
