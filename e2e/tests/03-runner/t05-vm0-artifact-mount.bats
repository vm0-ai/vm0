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
    export ARTIFACT_NAME="e2e-mount-test-$(date +%s%3N)-$RANDOM"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "VM0 artifact files are visible in sandbox working directory" {
    # Step 1: Create artifact with known content
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    # Create test files with known content
    echo "hello from artifact" > test-file.txt
    mkdir -p subdir
    echo "nested content" > subdir/nested.txt

    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Step 2: Run agent with artifact, list files
    # Use extended timeout for CI environments which may be slower
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
ls -la && cat test-file.txt && cat subdir/nested.txt" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"

    assert_success

    # Step 3: Verify files are visible
    # The agent should see our test files
    assert_output --partial "test-file.txt"
    assert_output --partial "subdir"
    assert_output --partial "hello from artifact"
    assert_output --partial "nested content"

    # Step 4: Verify run completes properly
    [ -n "$(run_fixture_field "$output" '.checkpointId')" ]
}

@test "VM0 artifact run completes with checkpoint" {
    # This test verifies run completion with artifact

    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "test" > data.txt
    seed_storage_fixture artifact "$ARTIFACT_NAME" . >/dev/null

    # Simple run that should complete
    # Use extended timeout for CI environments which may be slower
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
echo done" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"

    assert_success

    assert_equal "$(run_fixture_field "$output" '.status')" "completed"
}
