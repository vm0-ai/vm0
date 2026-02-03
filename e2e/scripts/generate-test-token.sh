#!/bin/bash
# Generate a test CLI token via API and save to config file
# Called by deploy-web job after Vercel deployment
#
# This creates a token that E2E tests can use immediately,
# without waiting for the device flow authentication.
#
# Prerequisites:
#   - VM0_API_URL environment variable must be set
#   - VERCEL_AUTOMATION_BYPASS_SECRET for Vercel bypass
#   - USE_MOCK_CLAUDE must be "true" on the server
#
# Usage: ./generate-test-token.sh

set -euo pipefail

echo "=== Generating Test CLI Token ==="

# Validate environment
if [[ -z "${VM0_API_URL:-}" ]]; then
  echo "Error: VM0_API_URL environment variable is required"
  exit 1
fi

echo "API URL: ${VM0_API_URL}"

# Build curl headers
CURL_HEADERS=(-H "Content-Type: application/json")
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  CURL_HEADERS+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
fi

# Call test-token endpoint
echo "Calling test-token endpoint..."
RESPONSE=$(curl -s -w "\n%{http_code}" \
  "${CURL_HEADERS[@]}" \
  -X POST \
  "${VM0_API_URL}/api/cli/auth/test-token")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: test-token endpoint returned $HTTP_CODE"
  echo "Response: $BODY"
  exit 1
fi

# Extract token from response
TOKEN=$(echo "$BODY" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$TOKEN" ]]; then
  echo "Error: Failed to extract token from response"
  echo "Response: $BODY"
  exit 1
fi

# Mask token in logs (show first 10 and last 4 chars)
MASKED_TOKEN="${TOKEN:0:10}...${TOKEN: -4}"
echo "Got token: $MASKED_TOKEN"

# Create config directory and file
CONFIG_DIR="$HOME/.vm0"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"

# Write config file
cat > "$CONFIG_FILE" << EOF
{
  "token": "$TOKEN",
  "apiUrl": "$VM0_API_URL"
}
EOF

echo ""
echo "=== Token generated successfully ==="
echo "Config file: $CONFIG_FILE"
