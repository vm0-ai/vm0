#!/usr/bin/env bats

# Test VM0 detailed error message capture
# This test verifies that when Claude Code fails, the error message
# contains the actual stderr output instead of generic "Agent exited with code 1"
#
# Test count: 2 tests with 1 vm0 run call

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t10"

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-t10"

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-error-test-$(date +%s%3N)-$RANDOM"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for error message testing"
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

@test "Build VM0 error message test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 run shows detailed error message on failure" {
    # This test uses the @fail: prefix in mock-claude to simulate
    # Claude Code failing with a specific stderr message

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test content" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with @fail: prefix to simulate failure
    # The mock-claude will output the message to stderr and exit with code 1
    echo "# Step 2: Running agent with simulated failure..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "@fail:Error: Could not resume session 'test-session': Session history file not found"

    # CLI should exit with non-zero code when agent fails (run status: failed)
    assert_failure

    # Step 3: Verify error message contains the detailed stderr content
    echo "# Step 3: Verifying error message..."
    echo "# Output: $output"

    # Should show failed status (not an event, just status text)
    assert_output --partial "Run failed"

    # Should contain the actual error message from stderr
    assert_output --partial "Could not resume session"
    assert_output --partial "Session history file not found"

    # Should NOT contain just the generic exit code message
    # (The detailed message should replace it)
    refute_output --partial "Agent exited with code 1"
}
