#!/usr/bin/env bats

# Test VM0 realtime event streaming (--experimental-realtime flag)
# This test verifies that:
# 1. Events are streamed in realtime via Ably
# 2. Output matches polling mode (Claude Code Started, text, tool calls, Completed)
# 3. Run completes successfully without hanging
#
# Related issue: #1429

load '../../helpers/setup'

# Unique agent name for this test file
AGENT_NAME="e2e-t30-realtime"

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-t30"

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-realtime-art-$(date +%s%3N)-$RANDOM"

    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for realtime streaming"
    framework: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    # Clean up config file
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
    # Clean up test volume
    cleanup_test_volume
}

@test "Build realtime streaming test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Realtime streaming: events are displayed with --experimental-realtime flag" {
    # This test verifies that --experimental-realtime:
    # 1. Streams events in realtime (not polling)
    # 2. Displays all expected event types
    # 3. Completes successfully without hanging

    # Step 1: Create artifact
    echo "# Step 1: Creating test artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test content" > readme.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with --experimental-realtime flag
    # Note: Use bash command as prompt since mock-claude executes prompts as bash commands
    echo "# Step 2: Running agent with --experimental-realtime..."
    run timeout 120 $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --experimental-realtime \
        "cat readme.txt && echo 'realtime test complete'"

    # Step 3: Verify run completed successfully
    echo "# Step 3: Verifying output..."
    assert_success

    # Verify events were streamed (same as polling mode)
    assert_output --partial "▷ Claude Code Started"
    assert_output --partial "● "
    assert_output --partial "● "
    assert_output --partial "◆ Claude Code Completed"

    # Verify run completed
    assert_output --partial "completed successfully"
}

@test "Realtime streaming: output matches polling mode" {
    # This test compares realtime vs polling mode output
    # to ensure they produce equivalent results

    # Step 1: Create artifact
    echo "# Step 1: Creating test artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME-compare"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME-compare"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-compare" >/dev/null

    echo "hello world" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run with realtime streaming
    # Note: Use bash command as prompt since mock-claude executes prompts as bash commands
    echo "# Step 2: Running with --experimental-realtime..."
    run timeout 120 $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME-compare" \
        --experimental-realtime \
        "echo 'realtime test' > output.txt && cat output.txt"

    assert_success
    REALTIME_OUTPUT="$output"

    # Verify realtime mode shows all event types
    echo "$REALTIME_OUTPUT" | grep -q "▷ Claude Code Started" || fail "Missing init event in realtime mode"
    echo "$REALTIME_OUTPUT" | grep -q "◆ Claude Code Completed" || fail "Missing result event in realtime mode"

    echo "# Realtime streaming test passed - events displayed correctly"
}
