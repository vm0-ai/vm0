#!/usr/bin/env bats

# Test runner network security mode (host-level proxy)
# This test verifies that:
# 1. Agent runs with experimental_network_security enabled on self-hosted runner
# 2. The mitmproxy on the runner host intercepts VM traffic
# 3. Network logs are captured and uploaded to telemetry endpoint
# 4. The vm0 logs --network command retrieves network logs
#
# The runner must have mitmproxy installed and CA cert baked into rootfs.

load '../../helpers/setup.bash'

# Verify test prerequisites
setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-runner-network-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-network-artifact-${UNIQUE_ID}"
}

teardown() {
    # Clean up test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "runner network security: run with proxy captures network traffic" {
    # Skip this test if SKIP_NETWORK_SECURITY_TEST is set
    # Useful for local development when mitmproxy isn't installed
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with experimental_runner and network_security"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E test agent for runner network security"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_network_security: true
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content for network security" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run the agent (runner should pick it up with network security)"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'testing runner network security'"

    echo "# Run output:"
    echo "$output"

    # Verify the run completed successfully
    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Extract Run ID from output
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    # Step 6: Verify vm0 logs --network command retrieves network logs
    echo "# Step 6: Fetching network logs..."
    run $CLI_COMMAND logs "$RUN_ID" --network --tail 100

    assert_success

    # Network logs should contain HTTP request information from webhook calls
    # The mitmproxy on the runner host intercepts ALL traffic including:
    # - Heartbeat requests (POST /api/webhooks/agent/heartbeat)
    # - Event requests (POST /api/webhooks/agent/events)
    # - Telemetry requests (POST /api/webhooks/agent/telemetry)
    # - Checkpoint requests (POST /api/webhooks/agent/checkpoints)
    # - Storage requests (POST /api/webhooks/agent/storages)

    # Should see POST requests to webhook endpoints
    assert_output --partial "POST"

    # Verify specific webhook endpoints are captured
    # Events endpoint is always called during agent execution
    assert_output --partial "/api/webhooks/agent/events"
    echo "# Network logs contain /api/webhooks/agent/events requests"
}

@test "runner network security: compose accepts experimental_network_security with runner" {
    echo "# Create config with both experimental_runner and experimental_network_security"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  network-runner-agent:
    description: "Test agent with runner and network security"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: acme/production
    experimental_network_security: true
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}
