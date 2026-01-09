#!/usr/bin/env bats

load '../../helpers/setup'

# Public API v1 E2E Tests
# Tests verify that API endpoints return valid JSON responses with expected structure

# Helper function to make authenticated API requests
api_get() {
    local endpoint="$1"
    curl -s \
        -H "Authorization: Bearer $VM0_TOKEN" \
        -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET:-}" \
        "${VM0_API_URL}${endpoint}"
}

setup() {
    # Get token from config file if not in environment
    if [[ -z "$VM0_TOKEN" ]]; then
        VM0_TOKEN=$(cat ~/.vm0/config.json | jq -r '.token')
        export VM0_TOKEN
    fi

    # Ensure API URL is set
    if [[ -z "$VM0_API_URL" ]]; then
        VM0_API_URL="https://www.vm0.ai"
        export VM0_API_URL
    fi
}

# ============================================
# Agents API Tests
# ============================================

@test "GET /v1/agents returns data array" {
    result=$(api_get "/v1/agents")
    echo "$result" | jq -e '.data' > /dev/null
}

@test "GET /v1/agents returns pagination object" {
    result=$(api_get "/v1/agents")
    echo "$result" | jq -e '.pagination' > /dev/null
}

# ============================================
# Runs API Tests
# ============================================

@test "GET /v1/runs returns data array" {
    result=$(api_get "/v1/runs")
    echo "$result" | jq -e '.data' > /dev/null
}

@test "GET /v1/runs returns pagination object" {
    result=$(api_get "/v1/runs")
    echo "$result" | jq -e '.pagination' > /dev/null
}

# ============================================
# Artifacts API Tests
# ============================================

@test "GET /v1/artifacts returns data array" {
    result=$(api_get "/v1/artifacts")
    echo "$result" | jq -e '.data' > /dev/null
}

@test "GET /v1/artifacts returns pagination object" {
    result=$(api_get "/v1/artifacts")
    echo "$result" | jq -e '.pagination' > /dev/null
}

# ============================================
# Volumes API Tests
# ============================================

@test "GET /v1/volumes returns data array" {
    result=$(api_get "/v1/volumes")
    echo "$result" | jq -e '.data' > /dev/null
}

@test "GET /v1/volumes returns pagination object" {
    result=$(api_get "/v1/volumes")
    echo "$result" | jq -e '.pagination' > /dev/null
}

# ============================================
# Tokens API Tests
# ============================================

@test "GET /v1/tokens returns data array" {
    result=$(api_get "/v1/tokens")
    echo "$result" | jq -e '.data' > /dev/null
}

@test "GET /v1/tokens returns pagination object" {
    result=$(api_get "/v1/tokens")
    echo "$result" | jq -e '.pagination' > /dev/null
}
