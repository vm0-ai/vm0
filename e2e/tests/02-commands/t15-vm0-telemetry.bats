#!/usr/bin/env bats

# Test VM0 telemetry collection and retrieval
# This test verifies that:
# 1. Agent runs display Run ID at start
# 2. Agent runs collect telemetry data (system log and metrics)
# 3. The vm0 logs command can retrieve telemetry data
#
# Test count: 2 tests with 1 vm0 run call

load '../../helpers/setup'

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-telemetry-test-$(date +%s)"
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-standard.yaml"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 telemetry test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-standard"
}

@test "VM0 telemetry: run displays Run ID and logs command retrieves data" {
    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    echo "test content" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with a simple command
    echo "# Step 2: Running agent to trigger telemetry collection..."
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'hello from agent'"

    assert_success

    # Verify "Run started" message with Run ID is displayed
    assert_output --partial "Run started"
    assert_output --partial "Run ID:"

    # Verify run completed successfully
    assert_output --partial "[result]"
    assert_output --partial "Run completed successfully"

    # Verify "vm0 logs" command hint is shown in next steps
    assert_output --partial "View telemetry logs:"
    assert_output --partial "vm0 logs"

    # Step 3: Extract Run ID from output
    # Format: "  Run ID:   abc12345-6789-..."
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    # Step 4: Verify vm0 logs command (default: agent events)
    echo "# Step 4: Fetching agent events (default)..."
    run $CLI_COMMAND logs "$RUN_ID"

    assert_success

    # Default output shows agent events - verify event type markers are present
    # Mock-claude produces: [init], [text], [tool_use], [tool_result], [result]
    assert_output --partial "[init]"
    assert_output --partial "[result]"
    echo "# Agent events contain expected event types"

    # Step 5: Verify --agent option explicitly shows agent events
    echo "# Step 5: Testing --agent option..."
    run $CLI_COMMAND logs "$RUN_ID" --agent

    assert_success
    assert_output --partial "[init]"
    echo "# --agent option works correctly"

    # Step 6: Verify --system option shows system logs
    echo "# Step 6: Testing --system option..."
    run $CLI_COMMAND logs "$RUN_ID" --system --limit 100

    assert_success
    # System log should contain sandbox log entries with INFO level
    # Format: [TIMESTAMP] [INFO] [sandbox:run-agent] message
    assert_output --partial "[INFO]"
    assert_output --partial "[sandbox:"
    echo "# System log contains expected log format"

    # Step 7: Verify --metrics option shows resource metrics
    echo "# Step 7: Testing --metrics option..."
    run $CLI_COMMAND logs "$RUN_ID" --metrics --limit 100

    assert_success
    # Metrics should contain CPU, memory, and disk information
    assert_output --partial "CPU:"
    assert_output --partial "Mem:"
    assert_output --partial "Disk:"
    echo "# Metrics contain expected resource data"

    # Step 8: Verify --limit option limits output
    echo "# Step 8: Testing --limit option..."
    run $CLI_COMMAND logs "$RUN_ID" --limit 2

    assert_success
    # With limit=2, should see at most 2 events
    # If more exist, should see "Use --limit to see more"
    echo "# Limit option works correctly"

    # Step 9: Verify mutually exclusive options are enforced
    echo "# Step 9: Testing mutually exclusive options..."
    run $CLI_COMMAND logs "$RUN_ID" --agent --system

    assert_failure
    assert_output --partial "mutually exclusive"
    echo "# Mutually exclusive options enforced correctly"
}
