#!/usr/bin/env bats

# Test VM0 network logs CLI command
# This test verifies that:
# 1. The vm0 logs --network command works correctly
# 2. Network log options are mutually exclusive with other log types
#
# Note: Network logs are only populated when beta_network_security is enabled
# and actual HTTPS traffic goes through the proxy. In mock mode, we test
# the CLI behavior rather than the full proxy flow.
#
# Test count: 2 tests with 1 vm0 run call

load '../../helpers/setup'

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-network-logs-test-$(date +%s)"
    # Use standard test config (no network security)
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test.yaml"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-test"
}

@test "VM0 logs --network: CLI options work correctly" {
    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    echo "test content for network logs" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to get a valid run ID
    echo "# Step 2: Running agent..."
    run $CLI_COMMAND run vm0-test \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'testing network logs'"

    assert_success
    assert_output --partial "Run started"
    assert_output --partial "Run ID:"
    assert_output --partial "Run completed successfully"

    # Step 3: Extract Run ID from output
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    # Step 4: Verify vm0 logs --network command returns successfully
    # (may show "No network logs found" since proxy wasn't enabled)
    echo "# Step 4: Fetching network logs..."
    run $CLI_COMMAND logs "$RUN_ID" --network --limit 100

    assert_success
    # Network logs may be empty (no proxy) or contain data (with proxy)
    # Just verify the command succeeds
    echo "# Network logs command succeeded"

    # Step 5: Verify --network is mutually exclusive with --agent
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
