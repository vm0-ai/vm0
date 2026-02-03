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

# Retry configuration
MAX_RETRIES=5
INITIAL_DELAY=2

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

# Check if error is retryable (Vercel alias propagation delay)
is_retryable_error() {
  local http_code="$1"
  local body="$2"

  # Retry on 404 with DEPLOYMENT_NOT_FOUND (Vercel alias not yet propagated)
  if [[ "$http_code" == "404" ]] && [[ "$body" == *"DEPLOYMENT_NOT_FOUND"* ]]; then
    return 0
  fi

  # Not retryable
  return 1
}

# Call test-token endpoint with retry logic
call_test_token_endpoint() {
  local attempt=1
  local delay=$INITIAL_DELAY
  local response http_code body

  while [[ $attempt -le $MAX_RETRIES ]]; do
    echo "Calling test-token endpoint (attempt $attempt/$MAX_RETRIES)..."

    response=$(curl -s -w "\n%{http_code}" \
      "${CURL_HEADERS[@]}" \
      -X POST \
      "${VM0_API_URL}/api/cli/auth/test-token" 2>&1) || true

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    # Success
    if [[ "$http_code" == "200" ]]; then
      if [[ $attempt -gt 1 ]]; then
        echo "Attempt $attempt/$MAX_RETRIES succeeded"
      fi
      echo "$body"
      return 0
    fi

    # Check if error is retryable
    if is_retryable_error "$http_code" "$body"; then
      if [[ $attempt -lt $MAX_RETRIES ]]; then
        echo "Attempt $attempt/$MAX_RETRIES failed (DEPLOYMENT_NOT_FOUND), retrying in ${delay}s..."
        sleep "$delay"
        delay=$((delay * 2))
        attempt=$((attempt + 1))
        continue
      fi
    fi

    # Non-retryable error or max retries exhausted
    echo "Error: test-token endpoint returned $http_code"
    echo "Response: $body"
    return 1
  done

  return 1
}

# Call endpoint with retry
BODY=$(call_test_token_endpoint) || exit 1

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
