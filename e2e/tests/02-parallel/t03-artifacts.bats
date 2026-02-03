#!/usr/bin/env bats

# E2E Integration Tests for Artifact Commands (Happy Path Only)
#
# These tests verify end-to-end artifact workflows that require real API interaction.
# Error handling and validation tests are in CLI integration tests:
#   turbo/apps/cli/src/commands/artifact/__tests__/pull.test.ts
#   turbo/apps/cli/src/commands/artifact/__tests__/push.test.ts
#
# Tests in this file:
# - Push artifact with files (core integration)
# - Multiple pushes create different versions (versioning)
# - Pull artifact gets HEAD version (core pull)
# - Pull specific version by versionId (versioning)
# - Status shows version info after push (full workflow)
#
# Migrated to CLI integration tests:
# - Pull non-existent version fails → pull.test.ts "should fail if version not found"

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp to avoid conflicts
    export ARTIFACT_NAME="e2e-test-artifact-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Push artifact to cloud and returns versionId" {
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "Hello from E2E test" > test-file.txt
    mkdir -p src
    echo "console.log('hello')" > src/index.js

    run $CLI_COMMAND artifact push
    assert_success
    assert_output --partial "Uploading"
    assert_output --partial "$ARTIFACT_NAME"
    # Verify versionId is returned (SHA-256 format - 64 hex chars, displayed as 8 char short version)
    assert_output --partial "Version:"
    assert_output --regexp "[0-9a-f]{8}"
}

@test "Multiple pushes create different versions" {
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    # First push
    echo "version 1" > data.txt
    run $CLI_COMMAND artifact push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Second push with different content
    echo "version 2" > data.txt
    run $CLI_COMMAND artifact push
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Versions should be different
    [ "$VERSION1" != "$VERSION2" ]
}

@test "Pull artifact from cloud gets HEAD version" {
    # First push multiple versions
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "version 1" > data.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "version 2" > data.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "version 3 - HEAD" > data.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt
    $CLI_COMMAND artifact push >/dev/null

    # Pull in a different directory
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $ARTIFACT_NAME
type: artifact
EOF

    run $CLI_COMMAND artifact pull
    assert_success
    assert_output --partial "Downloading"

    # Verify we got HEAD version (version 3)
    [ -f "data.txt" ]
    [ -f "subdir/nested.txt" ]
    run cat data.txt
    assert_output "version 3 - HEAD"

    rm -rf "$NEW_DIR"
}

@test "Pull specific version by versionId" {
    # Push multiple versions and capture their IDs
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    # Push version 1
    echo "content from version 1" > data.txt
    run $CLI_COMMAND artifact push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Push version 2
    echo "content from version 2" > data.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Push version 3 (HEAD)
    echo "content from version 3 - HEAD" > data.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Pull version 1 specifically (not HEAD)
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $ARTIFACT_NAME
type: artifact
EOF

    run $CLI_COMMAND artifact pull "$VERSION1"
    assert_success
    assert_output --partial "version: $VERSION1"

    # Verify we got version 1 content (not HEAD)
    [ -f "data.txt" ]
    run cat data.txt
    assert_output "content from version 1"

    rm -rf "$NEW_DIR"
}

@test "artifact status shows version info after push" {
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test content" > test-file.txt
    $CLI_COMMAND artifact push >/dev/null

    run $CLI_COMMAND artifact status
    assert_success
    assert_output --partial "Checking artifact"
    assert_output --partial "Found"
    assert_output --partial "Version:"
    assert_output --partial "Files:"
    assert_output --partial "Size:"
    assert_output --regexp "[0-9a-f]{8}"
}
