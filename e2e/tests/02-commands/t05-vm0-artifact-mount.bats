#!/usr/bin/env bats

# Test VM0 artifact mounting to sandbox
# Verifies that artifacts pushed via CLI are correctly mounted and visible
# in the sandbox during agent runs
#
# This test covers issue #213: artifact not mounted to sandbox

load '../../helpers/setup'

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-mount-test-$(date +%s)"
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-standard.yaml"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 artifact mount test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-standard"
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
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        "ls -la && cat test-file.txt && cat subdir/nested.txt"

    assert_success

    # Step 3: Verify files are visible
    # The agent should see our test files
    assert_output --partial "test-file.txt"
    assert_output --partial "subdir"
    assert_output --partial "hello from artifact"
    assert_output --partial "nested content"

    # Step 4: Verify run completes properly (vm0_result event)
    assert_output --partial "[result]"
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
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        "echo done"

    assert_success

    # Verify completion events
    assert_output --partial "[result]"
}
