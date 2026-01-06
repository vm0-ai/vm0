#!/usr/bin/env bats

# E2E tests for official runner support (vm0/production, vm0/development)
# These tests verify that:
# 1. Users can submit jobs to vm0/* groups
# 2. Official runners (using vm0_official_* token) can poll and claim these jobs
#
# Prerequisites:
# - OFFICIAL_RUNNER_SECRET must be set in the environment
# - A runner must be started with the official runner token format

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'
load '../../helpers/runner.bash'

# Verify test prerequisites
setup() {
    if [[ -z "$RUNNER_DIR" ]]; then
        skip "RUNNER_DIR not set - runner was not deployed"
    fi

    if ! ssh_check; then
        skip "Remote instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"
    fi

    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    if [[ -z "$OFFICIAL_RUNNER_SECRET" ]]; then
        skip "OFFICIAL_RUNNER_SECRET not set - official runner tests require this secret"
    fi

    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-official-runner-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-official-artifact-${UNIQUE_ID}"

    # Official runner group (vm0/development for testing)
    export OFFICIAL_RUNNER_GROUP="vm0/development"
}

teardown() {
    # Clean up test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# ============================================
# Official Runner E2E Tests
# ============================================

@test "official_runner: user can submit job to vm0/development group" {
    echo "# Testing that a regular user can submit jobs to official runner groups"

    echo "# Step 1: Create agent config targeting official runner group"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E test agent for official runner"
    provider: claude-code
    experimental_runner:
      group: ${OFFICIAL_RUNNER_GROUP}
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content for official runner e2e" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Compose output:"
    echo "$output"

    echo "# Step 4: Run the agent (official runner should pick it up)"
    # Note: This test requires an official runner to be started with the OFFICIAL_RUNNER_SECRET
    # If no official runner is running, the job will remain pending
    run timeout 120 $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from official runner test"

    echo "# Run output:"
    echo "$output"

    # Show runner logs only if command failed
    show_logs_on_failure

    # Verify the run completed successfully
    assert_success
}

@test "official_runner: vm0/production group is accessible to any user" {
    echo "# Testing vm0/production group accessibility"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  prod-test-agent:
    description: "Test agent targeting vm0/production"
    provider: claude-code
    experimental_runner:
      group: vm0/production
EOF

    echo "# Compose should succeed for vm0/production group"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "official_runner: vm0/development group is accessible to any user" {
    echo "# Testing vm0/development group accessibility"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  dev-test-agent:
    description: "Test agent targeting vm0/development"
    provider: claude-code
    experimental_runner:
      group: vm0/development
EOF

    echo "# Compose should succeed for vm0/development group"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "official_runner: invalid official runner secret is rejected" {
    # This test verifies that the API rejects invalid official runner secrets
    # We do this by making a direct API call with an invalid secret

    echo "# Testing that invalid official runner secret is rejected"

    # Make a direct poll request with invalid secret
    local response
    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer vm0_official_invalid_secret_12345" \
        -d '{"group":"vm0/development"}' \
        "${VM0_API_URL}/api/runners/poll")

    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')

    echo "# Response code: $http_code"
    echo "# Response body: $body"

    # Should return 401 Unauthorized
    [[ "$http_code" == "401" ]]
}

@test "official_runner: official runner cannot poll non-vm0 groups" {
    # This test verifies that official runners are restricted to vm0/* groups

    echo "# Testing that official runners cannot poll user groups"

    # Make a direct poll request to a user group with official token
    local response
    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer vm0_official_${OFFICIAL_RUNNER_SECRET}" \
        -d '{"group":"some-user/runner"}' \
        "${VM0_API_URL}/api/runners/poll")

    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')

    echo "# Response code: $http_code"
    echo "# Response body: $body"

    # Should return 403 Forbidden
    [[ "$http_code" == "403" ]]
    [[ "$body" == *"vm0/* groups"* ]] || [[ "$body" == *"Official runners"* ]]
}
