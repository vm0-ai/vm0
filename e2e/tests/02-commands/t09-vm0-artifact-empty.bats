#!/usr/bin/env bats

# Test VM0 agent run with empty/unchanged artifact
# Verifies that storage webhook correctly handles empty zip uploads
#
# This test covers issue #305: storage webhook fails with 500 when artifact has no changes

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t09"

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-empty-artifact-$(date +%s)"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for empty artifact testing"
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

@test "Build VM0 empty artifact test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 run with empty artifact completes successfully" {
    # Create empty artifact (no files)
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

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
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"
}

@test "VM0 run with unchanged artifact completes successfully" {
    # Create artifact with files
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    echo "existing content" > data.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt

    run $CLI_COMMAND artifact push
    assert_success

    # Run agent that only reads files (no modifications)
    # The storage webhook should handle unchanged artifact content correctly
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "cat data.txt && cat subdir/nested.txt"

    assert_success

    # Verify run completes properly with checkpoint
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"
    assert_output --partial "existing content"
    assert_output --partial "nested file"
}

@test "Push empty artifact after non-empty updates HEAD correctly" {
    # This test verifies the fix for issue #617:
    # Push with files first, then push empty, and verify pull gets empty artifact
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    # First push with files
    echo "version 1 with files" > data.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt
    run $CLI_COMMAND artifact push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Remove all files (make it empty)
    rm -rf data.txt subdir

    # Push empty artifact
    run $CLI_COMMAND artifact push
    assert_success
    assert_output --partial "No files found (empty artifact)"
    VERSION2=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Verify versions are different
    [ "$VERSION1" != "$VERSION2" ]

    # Pull in a different directory to verify HEAD was updated to empty
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $ARTIFACT_NAME
type: artifact
EOF

    run $CLI_COMMAND artifact pull
    assert_success

    # Verify we got empty artifact (not the old files)
    local file_count=$(find . -type f ! -path './.vm0/*' | wc -l)
    [ "$file_count" -eq 0 ]

    rm -rf "$NEW_DIR"
}

@test "Push empty artifact twice with files in between updates HEAD correctly" {
    # This test verifies the fix for issue #626:
    # When pushing an empty artifact that was previously pushed (deduplication path),
    # HEAD should still be updated to point to the empty version
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    # Step 1: Push with files
    echo "version 1 with files" > data.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Push empty (first time - creates empty version)
    rm -rf data.txt
    run $CLI_COMMAND artifact push
    assert_success
    assert_output --partial "No files found (empty artifact)"
    VERSION_EMPTY=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Step 3: Push with files again (HEAD now points to files version)
    echo "version 2 with files" > data.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Push empty again (hits deduplication path)
    # Bug #626: HEAD was not updated because commit was skipped
    rm -rf data.txt
    run $CLI_COMMAND artifact push
    assert_success
    assert_output --partial "No files found (empty artifact)"
    VERSION_EMPTY2=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Empty versions should have same ID (content-addressable)
    [ "$VERSION_EMPTY" = "$VERSION_EMPTY2" ]

    # Pull in a different directory to verify HEAD was updated to empty
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $ARTIFACT_NAME
type: artifact
EOF

    run $CLI_COMMAND artifact pull
    assert_success

    # Verify we got empty artifact (not the files from step 3)
    local file_count=$(find . -type f ! -path './.vm0/*' | wc -l)
    [ "$file_count" -eq 0 ]

    rm -rf "$NEW_DIR"
}

@test "VM0 artifact pull succeeds after agent removes all files" {
    # Create artifact with files
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

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
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"

    # Now pull the empty artifact - this should succeed, not fail with TAR_BAD_ARCHIVE
    # Bug fix: empty archives created by archiver may not be valid tar format
    run $CLI_COMMAND artifact pull
    assert_success

    # Verify local directory is now empty (except .vm0)
    local file_count=$(find . -type f ! -path './.vm0/*' | wc -l)
    [ "$file_count" -eq 0 ]
}

@test "VM0 artifact pull succeeds after sandbox deduplication (issue #649)" {
    # This test verifies the fix for issue #649:
    # When sandbox creates a checkpoint with same artifact content (deduplication),
    # the commit endpoint should still be called to update HEAD pointer.
    # Without this fix, auto-pull would use outdated HEAD and fail with 404.

    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    # Step 1: Create artifact with files
    echo "test content" > data.txt
    run $CLI_COMMAND artifact push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Step 2: Run agent that only reads files (no modifications)
    # This creates a checkpoint where artifact content is unchanged
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "cat data.txt"
    assert_success
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"
    # Extract artifact version from run output
    RUN_VERSION=$(echo "$output" | grep -oP 'artifact:\s+\K[0-9a-f]+' | tail -1)

    # Step 3: Run agent again - this triggers sandbox deduplication
    # The artifact content is the same, so sandbox gets existing=true from prepare
    # Bug #649: sandbox returned early without calling commit, HEAD was not updated
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "cat data.txt"
    assert_success
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"

    # Step 4: Pull artifact - this should succeed
    # Before fix: would fail with 404 because HEAD pointed to wrong version
    run $CLI_COMMAND artifact pull
    assert_success

    # Verify file content is correct
    [ -f "data.txt" ]
    grep -q "test content" data.txt
}

@test "VM0 consecutive runs with unchanged artifact both succeed with pull" {
    # Additional test for issue #649:
    # Run multiple times without modifying artifact, verify pull works each time
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    # Create artifact with files
    echo "unchanged content" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Run 1: read-only operation
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "cat file.txt"
    assert_success
    assert_output --partial "Checkpoint:"

    # Pull after run 1
    run $CLI_COMMAND artifact pull
    assert_success
    [ -f "file.txt" ]

    # Run 2: another read-only operation (deduplication in sandbox)
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "wc -l file.txt"
    assert_success
    assert_output --partial "Checkpoint:"

    # Pull after run 2 - this is where bug #649 would cause 404
    run $CLI_COMMAND artifact pull
    assert_success
    [ -f "file.txt" ]
    grep -q "unchanged content" file.txt
}
