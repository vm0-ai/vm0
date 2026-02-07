#!/usr/bin/env bats

load '../../helpers/setup'

# Compose from GitHub API E2E Tests
# Tests verify that the GitHub compose workflow works end-to-end

# Test GitHub repository URL (must contain a valid vm0.yaml)
TEST_GITHUB_URL="https://github.com/vm0-ai/vm0-cookbooks/tree/main/examples/201-hackernews"

# Polling configuration
MAX_POLL_ATTEMPTS=60
POLL_INTERVAL_SECONDS=5

# Helper function to make authenticated API POST requests
api_post() {
    local endpoint="$1"
    local data="$2"
    local result

    result=$(curl -s -X POST \
        -H "Authorization: Bearer $VM0_TOKEN" \
        -H "Content-Type: application/json" \
        -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}" \
        -d "$data" \
        "${VM0_API_URL}${endpoint}")

    if ! echo "$result" | jq -e '.' > /dev/null 2>&1; then
        echo "# Non-JSON response (first 200 chars): ${result:0:200}" >&3
    fi
    echo "$result"
}

# Helper function to make authenticated API GET requests
api_get() {
    local endpoint="$1"
    local result

    result=$(curl -s \
        -H "Authorization: Bearer $VM0_TOKEN" \
        -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}" \
        "${VM0_API_URL}${endpoint}")

    if ! echo "$result" | jq -e '.' > /dev/null 2>&1; then
        echo "# Non-JSON response (first 200 chars): ${result:0:200}" >&3
    fi
    echo "$result"
}

# Poll job status until completion or timeout
poll_job_until_complete() {
    local job_id="$1"
    local attempt=0
    local status

    while [[ $attempt -lt $MAX_POLL_ATTEMPTS ]]; do
        result=$(api_get "/api/compose/from-github/${job_id}")
        status=$(echo "$result" | jq -r '.status')

        echo "# Poll attempt $((attempt + 1))/${MAX_POLL_ATTEMPTS}: status=$status" >&3

        if [[ "$status" == "completed" ]] || [[ "$status" == "failed" ]]; then
            echo "$result"
            return 0
        fi

        sleep $POLL_INTERVAL_SECONDS
        attempt=$((attempt + 1))
    done

    echo "# Timeout waiting for job $job_id to complete" >&3
    echo "$result"
    return 1
}

setup() {
    # Verify VERCEL_AUTOMATION_BYPASS_SECRET is set
    if [[ -z "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        echo "ERROR: VERCEL_AUTOMATION_BYPASS_SECRET is not set or empty" >&2
        echo "This test requires a valid Vercel bypass secret for preview deployments" >&2
        exit 1
    fi

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
# Compose from GitHub E2E Tests
# ============================================

@test "POST /api/compose/from-github creates a compose job" {
    result=$(api_post "/api/compose/from-github" "{\"githubUrl\": \"${TEST_GITHUB_URL}\"}")

    # Verify response structure
    echo "$result" | jq -e '.jobId' > /dev/null
    echo "$result" | jq -e '.status' > /dev/null
    echo "$result" | jq -e '.githubUrl' > /dev/null

    # Verify status is pending or running (may have already started)
    status=$(echo "$result" | jq -r '.status')
    [[ "$status" == "pending" ]] || [[ "$status" == "running" ]]
}

@test "Compose from GitHub completes successfully" {
    # Create job
    create_result=$(api_post "/api/compose/from-github" "{\"githubUrl\": \"${TEST_GITHUB_URL}\", \"overwrite\": true}")

    # Extract job ID (handle both 201 new job and 200 existing job)
    job_id=$(echo "$create_result" | jq -r '.jobId')
    [[ -n "$job_id" ]] && [[ "$job_id" != "null" ]]
    echo "# Created compose job: $job_id" >&3

    # Poll until complete
    final_result=$(poll_job_until_complete "$job_id")
    status=$(echo "$final_result" | jq -r '.status')

    echo "# Final status: $status" >&3

    # If failed, output error for debugging
    if [[ "$status" == "failed" ]]; then
        error=$(echo "$final_result" | jq -r '.error // "no error message"')
        echo "# Job error: $error" >&3
    fi

    # Verify job completed successfully
    [[ "$status" == "completed" ]]

    # Verify result contains compose information
    echo "$final_result" | jq -e '.result.composeId' > /dev/null
    echo "$final_result" | jq -e '.result.composeName' > /dev/null
    echo "$final_result" | jq -e '.result.versionId' > /dev/null

    compose_id=$(echo "$final_result" | jq -r '.result.composeId')
    compose_name=$(echo "$final_result" | jq -r '.result.composeName')
    echo "# Created compose: $compose_name (ID: $compose_id)" >&3
}

@test "GET /api/compose/from-github/:jobId returns job status" {
    # Create job first
    create_result=$(api_post "/api/compose/from-github" "{\"githubUrl\": \"${TEST_GITHUB_URL}\"}")
    job_id=$(echo "$create_result" | jq -r '.jobId')

    # Get job status
    result=$(api_get "/api/compose/from-github/${job_id}")

    # Verify response structure
    echo "$result" | jq -e '.jobId' > /dev/null
    echo "$result" | jq -e '.status' > /dev/null
    echo "$result" | jq -e '.githubUrl' > /dev/null
    echo "$result" | jq -e '.createdAt' > /dev/null

    # Verify job ID matches
    returned_job_id=$(echo "$result" | jq -r '.jobId')
    [[ "$returned_job_id" == "$job_id" ]]
}

@test "GET /api/compose/from-github/:jobId returns 404 for non-existent job" {
    non_existent_id="00000000-0000-0000-0000-000000000000"

    result=$(curl -s -w "\n%{http_code}" \
        -H "Authorization: Bearer $VM0_TOKEN" \
        -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}" \
        "${VM0_API_URL}/api/compose/from-github/${non_existent_id}")

    # Extract HTTP status code (last line)
    http_code=$(echo "$result" | tail -n1)

    [[ "$http_code" == "404" ]]
}
