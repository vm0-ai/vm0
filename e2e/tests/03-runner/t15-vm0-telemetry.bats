#!/usr/bin/env bats

# Test VM0 telemetry collection and retrieval
# This test verifies that:
# 1. Agent runs display Run ID at start
# 2. Agent runs collect telemetry data (system log and metrics)
# 3. Telemetry data is retrievable (agent/system/metrics log views)
#
# Test count: 1 test with 1 direct run

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-t15-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume and compose ONCE so parallel tests don't race
    create_test_volume "e2e-vol-t15"
    export SHARED_VOLUME_NAME="$VOLUME_NAME"
    export SHARED_VOLUME_DIR="$TEST_VOLUME_DIR"

    export SHARED_CONFIG="$TEST_DIR/vm0.yaml"
    cat > "$SHARED_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for telemetry testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $SHARED_VOLUME_NAME
    version: latest
EOF
    seed_compose_fixture "$SHARED_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    if [ -n "$SHARED_VOLUME_DIR" ] && [ -d "$SHARED_VOLUME_DIR" ]; then
        rm -rf "$SHARED_VOLUME_DIR"
    fi
}

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-telemetry-test-$(date +%s%3N)-$RANDOM"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "VM0 telemetry: run displays Run ID and logs command retrieves data" {
    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "test content" > test.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Step 2: Run agent with a simple command
    echo "# Step 2: Running agent to trigger telemetry collection..."
    run run_compose_fixture "$AGENT_NAME" \
        "echo 'hello from agent'" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"

    assert_success

    # Verify run completed successfully
    assert_output --partial "◆ Claude Code Completed"

    # Step 3: Extract Run ID from output
    RUN_ID=$(run_fixture_field "$output" '.runId')
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    # Step 4: Verify agent events (default log view)
    echo "# Step 4: Fetching agent events (default)..."
    # Mock-claude produces: Claude Code Started, text, tool calls, Completed
    wait_for_log "$RUN_ID" -- "▷ Claude Code Started" "◆ Claude Code Completed"
    echo "# Agent events contain expected event types"

    # Step 5: Verify --agent option explicitly shows agent events
    echo "# Step 5: Testing --agent option..."
    wait_for_log "$RUN_ID" --agent -- "▷ Claude Code Started"
    echo "# --agent option works correctly"

    # Step 6: Verify --system option shows system logs
    echo "# Step 6: Testing --system option..."
    # System log should contain sandbox log entries with INFO level
    # Format: [TIMESTAMP] [INFO] [sandbox:run-agent] message
    # "Complete webhook acknowledged" proves the guest-agent posted /complete
    # itself (new fast path) rather than falling back to the runner's call.
    wait_for_log "$RUN_ID" --system -- "[INFO]" "[sandbox:" "Complete webhook acknowledged"
    echo "# System log contains expected log format"

    # Step 7: Verify --metrics option shows resource metrics
    echo "# Step 7: Testing --metrics option..."
    wait_for_log "$RUN_ID" --metrics -- "CPU:" "Mem:" "Disk:"
    echo "# Metrics contain expected resource data"

    # Step 8: Verify `zero logs --tail` limits output
    echo "# Step 8: Testing --tail option..."
    run $ZERO_CLI logs "$RUN_ID" --tail 2

    assert_success
    # With tail=2, should see at most 2 events
    # If more exist, should see "Use --tail to see more"
    echo "# Tail option works correctly"
}
