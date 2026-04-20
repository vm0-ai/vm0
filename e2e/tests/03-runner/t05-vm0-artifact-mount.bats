#!/usr/bin/env bats

# Test VM0 artifact mounting to sandbox
# Verifies that artifacts pushed via CLI are correctly mounted and visible
# in the sandbox during agent runs
#
# This test covers issue #213: artifact not mounted to sandbox

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-t05-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume and compose ONCE so parallel tests don't race
    create_test_volume "e2e-vol-t05"
    export SHARED_VOLUME_NAME="$VOLUME_NAME"
    export SHARED_VOLUME_DIR="$TEST_VOLUME_DIR"

    export SHARED_CONFIG="$TEST_DIR/vm0.yaml"
    cat > "$SHARED_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for artifact mount testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
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
    export ARTIFACT_NAME="e2e-mount-test-$(date +%s%3N)-$RANDOM"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 artifact mount test agent configuration" {
    run $VM0_CLI compose "$SHARED_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 artifact files are visible in sandbox working directory" {
    # Step 1: Create artifact with known content
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null

    # Create test files with known content
    echo "hello from artifact" > test-file.txt
    mkdir -p subdir
    echo "nested content" > subdir/nested.txt

    run $VM0_CLI artifact push
    assert_success

    # Step 2: Run agent with artifact, list files
    # Use extended timeout for CI environments which may be slower
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME" \
        --verbose \
        "ls -la && cat test-file.txt && cat subdir/nested.txt"

    assert_success

    # Step 3: Verify files are visible
    # The agent should see our test files
    assert_output --partial "test-file.txt"
    assert_output --partial "subdir"
    assert_output --partial "hello from artifact"
    assert_output --partial "nested content"

    # Step 4: Verify run completes properly
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Run completed successfully"
    assert_output --partial "Checkpoint:"
}

@test "VM0 artifact run completes with checkpoint" {
    # This test verifies run completion with artifact

    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > data.txt
    $VM0_CLI artifact push >/dev/null

    # Simple run that should complete
    # Use extended timeout for CI environments which may be slower
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME" \
        "echo done"

    assert_success

    # Verify run completed successfully
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Run completed successfully"
}
