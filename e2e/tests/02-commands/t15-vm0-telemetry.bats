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

    # Step 4: Verify vm0 logs command works with the Run ID
    echo "# Step 4: Fetching telemetry logs..."
    run $CLI_COMMAND logs "$RUN_ID"

    assert_success

    # The logs command should return telemetry data
    # With mock-claude, there may be minimal telemetry, but command should succeed
    # In real runs, systemLog would contain agent execution logs
    # and metrics would contain CPU/memory/disk usage

    echo "# Telemetry logs retrieved successfully"
    echo "# Output: $output"

    # Step 5: Verify JSON output mode works
    echo "# Step 5: Testing JSON output mode..."
    run $CLI_COMMAND logs "$RUN_ID" --json

    assert_success

    # JSON output should be valid (contains expected fields)
    assert_output --partial "systemLog"
    assert_output --partial "metrics"

    echo "# JSON telemetry output verified"
}
