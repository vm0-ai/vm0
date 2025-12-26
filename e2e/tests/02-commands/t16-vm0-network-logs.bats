#!/usr/bin/env bats

# Test VM0 network logs with network security mode
# This test verifies that:
# 1. Agent runs with experimental_network_security enabled capture network traffic
# 2. The vm0 logs --network command retrieves network logs
# 3. Network logs contain expected fields (method, url, status, latency)
#
# Test count: 2 tests with 1 vm0 run call

load '../../helpers/setup'

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-network-logs-test-$(date +%s)"
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-network-security.yaml"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 network security test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-network-security"
}

@test "VM0 network logs: run with network security captures network traffic" {
    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    echo "test content for network logs" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with network security enabled
    # The agent will make API calls to Claude which will be proxied
    echo "# Step 2: Running agent with network security (proxy mode)..."
    run $CLI_COMMAND run vm0-network-security \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'testing network logs'"

    assert_success

    # Verify run completed successfully
    assert_output --partial "Run started"
    assert_output --partial "Run ID:"
    assert_output --partial "[result]"
    assert_output --partial "Run completed successfully"

    # Step 3: Extract Run ID from output
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    # Step 4: Verify vm0 logs --network command retrieves network logs
    echo "# Step 4: Fetching network logs..."
    run $CLI_COMMAND logs "$RUN_ID" --network --limit 100

    assert_success

    # Network logs should contain HTTP request information from webhook calls
    # The mitmproxy intercepts ALL traffic including:
    # - Heartbeat requests (POST /api/webhooks/agent/heartbeat)
    # - Event requests (POST /api/webhooks/agent/events)
    # - Telemetry requests (POST /api/webhooks/agent/telemetry)
    # - Checkpoint requests (POST /api/webhooks/agent/checkpoints)
    # - Storage requests (POST /api/webhooks/agent/storages)
    #
    # Format: [timestamp] METHOD status latency request_size/response_size url

    # Should see POST requests to webhook endpoints
    assert_output --partial "POST"

    # Verify specific webhook endpoints are captured
    # Events endpoint is always called during agent execution
    assert_output --partial "/api/webhooks/agent/events"
    echo "# Network logs contain /api/webhooks/agent/events requests"

    # Step 5: Verify --network is mutually exclusive with other options
    echo "# Step 5: Testing --network mutually exclusive with --agent..."
    run $CLI_COMMAND logs "$RUN_ID" --network --agent

    assert_failure
    assert_output --partial "mutually exclusive"
    echo "# --network is mutually exclusive with --agent"

    # Step 6: Verify --network is mutually exclusive with --system
    echo "# Step 6: Testing --network mutually exclusive with --system..."
    run $CLI_COMMAND logs "$RUN_ID" --network --system

    assert_failure
    assert_output --partial "mutually exclusive"
    echo "# --network is mutually exclusive with --system"

    # Step 7: Verify --network is mutually exclusive with --metrics
    echo "# Step 7: Testing --network mutually exclusive with --metrics..."
    run $CLI_COMMAND logs "$RUN_ID" --network --metrics

    assert_failure
    assert_output --partial "mutually exclusive"
    echo "# --network is mutually exclusive with --metrics"

    # Step 8: Verify -n short option works
    echo "# Step 8: Testing -n short option..."
    run $CLI_COMMAND logs "$RUN_ID" -n --limit 10

    assert_success
    echo "# -n short option works correctly"
}
