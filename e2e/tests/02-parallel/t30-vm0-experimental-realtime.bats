#!/usr/bin/env bats

# Test --experimental-realtime flag for Ably-based event streaming
# This test verifies that:
# 1. The --experimental-realtime flag is accepted by vm0 run commands
# 2. Realtime streaming works correctly when ABLY_API_KEY is configured
#
# Note: This test requires ABLY_API_KEY to be configured on the server.
# If Ably is not configured, the test should fail (not fallback silently).

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-realtime"

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-realtime"

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-realtime-art-$(date +%s%3N)-$RANDOM"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for realtime streaming"
    provider: claude-code
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

@test "Build realtime test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "vm0 run --experimental-realtime completes successfully" {
    # This test verifies that --experimental-realtime flag works end-to-end
    # with Ably-based event streaming

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with --experimental-realtime flag
    echo "# Step 2: Running agent with --experimental-realtime..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --experimental-realtime \
        "echo 'hello from realtime' && cat testfile.txt"

    # Should succeed
    assert_success

    # Verify we got the expected output events
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "[result]"
    assert_output --partial "hello from realtime"
    assert_output --partial "test content"

    # Should have checkpoint and session (run completed successfully)
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    echo "# Verified: --experimental-realtime completed successfully"
}

@test "vm0 run resume --experimental-realtime works correctly" {
    # This test verifies that resume works with --experimental-realtime flag

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to create checkpoint (without realtime for initial run)
    echo "# Step 2: Running agent to create checkpoint..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run' > result.txt"

    assert_success
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Step 3: Resume with --experimental-realtime
    echo "# Step 3: Resuming with --experimental-realtime..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        --experimental-realtime \
        "cat result.txt && echo 'resumed with realtime'"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "first run"
    assert_output --partial "resumed with realtime"

    echo "# Verified: resume with --experimental-realtime works"
}

@test "vm0 run continue --experimental-realtime works correctly" {
    # This test verifies that continue works with --experimental-realtime flag

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "session test" > session.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to create session (without realtime for initial run)
    echo "# Step 2: Running agent to create session..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'session created' && cat session.txt"

    assert_success
    assert_output --partial "Session:"

    # Extract session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Step 3: Continue with --experimental-realtime
    echo "# Step 3: Continuing with --experimental-realtime..."
    run $CLI_COMMAND run continue "$SESSION_ID" \
        --experimental-realtime \
        "echo 'continued with realtime'"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "continued with realtime"

    echo "# Verified: continue with --experimental-realtime works"
}
