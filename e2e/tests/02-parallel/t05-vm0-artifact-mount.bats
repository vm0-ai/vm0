#!/usr/bin/env bats

# Test VM0 artifact mounting to sandbox
# Verifies that artifacts pushed via CLI are correctly mounted and visible
# in the sandbox during agent runs
#
# This test covers issue #213: artifact not mounted to sandbox

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t05"

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-mount-test-$(date +%s)"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for artifact mount testing"
    provider: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: claude-files
    version: latest
EOF
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    # Clean up config file
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
}

@test "Build VM0 artifact mount test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 artifact files are visible in sandbox working directory" {
    # Step 1: Create artifact with known content
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    # Create test files with known content
    echo "hello from artifact" > test-file.txt
    mkdir -p subdir
    echo "nested content" > subdir/nested.txt

    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with artifact, list files
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "ls -la && cat test-file.txt && cat subdir/nested.txt"

    assert_success

    # Step 3: Verify files are visible
    # The agent should see our test files
    assert_output --partial "test-file.txt"
    assert_output --partial "subdir"
    assert_output --partial "hello from artifact"
    assert_output --partial "nested content"

    # Step 4: Verify run completes properly
    assert_output --partial "[result]"
    assert_output --partial "Run completed successfully"
    assert_output --partial "Checkpoint:"
}

@test "VM0 artifact run completes with checkpoint" {
    # This test verifies run completion with artifact

    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    echo "test" > data.txt
    $CLI_COMMAND artifact push >/dev/null

    # Simple run that should complete
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo done"

    assert_success

    # Verify run completed successfully
    assert_output --partial "[result]"
    assert_output --partial "Run completed successfully"
}
