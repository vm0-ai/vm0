#!/usr/bin/env bats

# Test VM0 telemetry collection and retrieval
# This test verifies that:
# 1. Agent runs display Run ID at start
# 2. Agent runs collect telemetry data (system log and metrics)
# 3. The vm0 logs command can retrieve telemetry data
#
# Test count: 2 tests with 1 vm0 run call

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
    $VM0_CLI compose "$SHARED_CONFIG" >/dev/null
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

@test "Build VM0 telemetry test agent configuration" {
    run $VM0_CLI compose "$SHARED_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 telemetry: run displays Run ID and logs command retrieves data" {
    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test content" > test.txt
    run $VM0_CLI artifact push
    assert_success

    # Step 2: Run agent with a simple command
    echo "# Step 2: Running agent to trigger telemetry collection..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo 'hello from agent'"

    assert_success

    # Verify "Run started" message with Run ID is displayed
    assert_output --partial "Run started"
    assert_output --partial "Run ID:"

    # Verify run completed successfully
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Run completed successfully"

    # Verify "vm0 logs" command hint is shown in next steps
    assert_output --partial "View agent logs:"
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

    # Step 8: Verify --tail option limits output
    echo "# Step 8: Testing --tail option..."
    run $VM0_CLI logs "$RUN_ID" --tail 2

    assert_success
    # With tail=2, should see at most 2 events
    # If more exist, should see "Use --tail to see more"
    echo "# Tail option works correctly"

    # Note: Mutually exclusive options validation (--agent, --system, etc.)
    # is tested in CLI integration tests:
    # turbo/apps/cli/src/commands/logs/__tests__/index.test.ts
    #   - "should exit with error when multiple log types specified"
}
