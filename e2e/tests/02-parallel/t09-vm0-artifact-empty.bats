#!/usr/bin/env bats

# Test VM0 agent run with empty/unchanged artifact
# Verifies that storage webhook correctly handles empty zip uploads
#
# This test covers issue #305: storage webhook fails with 500 when artifact has no changes
#
# NOTE: Storage-specific logic tests (HEAD pointer update, deduplication) have been
# moved to unit tests: turbo/apps/web/src/lib/__tests__/artifact-storage.test.ts
# This file now contains only E2E integration tests that require actual agent execution.

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t09"

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-t09"

    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-empty-artifact-$(date +%s%3N)-$RANDOM"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for empty artifact testing"
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

@test "Build VM0 empty artifact test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 run with empty artifact completes successfully" {
    # Create empty artifact (no files)
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    # Push empty artifact
    run $CLI_COMMAND artifact push
    assert_success

    # Run agent with operation that doesn't create any files
    # This tests the storage webhook handling of empty zip uploads
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'hello world'"

    assert_success

    # Verify run completes properly with checkpoint
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
}

@test "VM0 run with unchanged artifact completes successfully" {
    # Create artifact with files
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "existing content" > data.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt

    run $CLI_COMMAND artifact push
    assert_success

    # Run agent that only reads files (no modifications)
    # The storage webhook should handle unchanged artifact content correctly
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "cat data.txt && cat subdir/nested.txt"

    assert_success

    # Verify run completes properly with checkpoint
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "existing content"
    assert_output --partial "nested file"
}

@test "VM0 artifact pull succeeds after agent removes all files" {
    # Create artifact with files
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "file to be deleted" > delete-me.txt
    mkdir -p subdir
    echo "nested file to delete" > subdir/nested.txt

    run $CLI_COMMAND artifact push
    assert_success

    # Run agent that deletes all files
    # This creates a checkpoint with empty artifact
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "rm -rf delete-me.txt subdir"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"

    # Now pull the empty artifact - this should succeed, not fail with TAR_BAD_ARCHIVE
    # Bug fix: empty archives created by archiver may not be valid tar format
    run $CLI_COMMAND artifact pull
    assert_success

    # Verify local directory is now empty (except .vm0)
    local file_count=$(find . -type f ! -path './.vm0/*' | wc -l)
    [ "$file_count" -eq 0 ]
}
