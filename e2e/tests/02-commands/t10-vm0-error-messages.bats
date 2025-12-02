#!/usr/bin/env bats

# Test VM0 detailed error message capture
# This test verifies that when Claude Code fails, the error message
# contains the actual stderr output instead of generic "Agent exited with code 1"
#
# Test count: 2 tests with 1 vm0 run call

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-error-test-$(date +%s)"
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-standard.yaml"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 error message test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-standard"
}

@test "VM0 run shows detailed error message on failure" {
    # This test uses the @fail: prefix in mock-claude to simulate
    # Claude Code failing with a specific stderr message

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    echo "test content" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with @fail: prefix to simulate failure
    # The mock-claude will output the message to stderr and exit with code 1
    echo "# Step 2: Running agent with simulated failure..."
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        --timeout 120 \
        "@fail:Error: Could not resume session 'test-session': Session history file not found"

    # CLI should exit with non-zero code when agent fails (vm0_error received)
    assert_failure

    # Step 3: Verify error message contains the detailed stderr content
    echo "# Step 3: Verifying error message..."
    echo "# Output: $output"

    # Should show vm0_error event
    assert_output --partial "[vm0_error]"
    assert_output --partial "Run failed"

    # Should contain the actual error message from stderr
    assert_output --partial "Could not resume session"
    assert_output --partial "Session history file not found"

    # Should NOT contain just the generic exit code message
    # (The detailed message should replace it)
    refute_output --partial "Agent exited with code 1"
}
