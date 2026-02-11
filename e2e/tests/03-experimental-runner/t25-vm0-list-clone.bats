#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 artifact/volume list and clone command tests
#
# This file contains only true integration tests that verify:
# - List commands with actual remote artifacts/volumes
# - Clone commands with actual file download and content verification
# - Edge cases like empty storages
#
# Tests for command configuration (help text, aliases, arguments) are covered
# by unit tests in turbo/apps/cli/src/__tests__/list-clone-command.test.ts

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-list-artifact-${UNIQUE_ID}"
    export VOLUME_NAME="e2e-list-volume-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# ============================================
# Artifact List Tests
# ============================================

@test "vm0 artifact list shows pushed artifact" {
    echo "# Step 1: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: List artifacts"
    run $CLI_COMMAND artifact list
    assert_success
    assert_output --partial "$ARTIFACT_NAME"
    assert_output --partial "NAME"
    assert_output --partial "SIZE"
    assert_output --partial "FILES"
    assert_output --partial "UPDATED"
}

# ============================================
# Volume List Tests
# ============================================

@test "vm0 volume list shows pushed volume" {
    echo "# Step 1: Create and push volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "test content" > test.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: List volumes"
    run $CLI_COMMAND volume list
    assert_success
    assert_output --partial "$VOLUME_NAME"
    assert_output --partial "NAME"
    assert_output --partial "SIZE"
}

# ============================================
# Artifact Clone Tests
# ============================================

@test "vm0 artifact clone succeeds for existing artifact" {
    echo "# Step 1: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "hello from artifact" > hello.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone artifact to new directory"
    cd "$TEST_DIR"
    CLONE_DIR="${ARTIFACT_NAME}-clone"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Successfully cloned"
    assert_output --partial "$ARTIFACT_NAME"

    echo "# Step 3: Verify cloned files"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/hello.txt" ]
    [ -f "$CLONE_DIR/subdir/nested.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/hello.txt"
    assert_output "hello from artifact"
}

# ============================================
# Volume Clone Tests
# ============================================

@test "vm0 volume clone succeeds for existing volume" {
    echo "# Step 1: Create and push volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "hello from volume" > hello.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Clone volume to new directory"
    cd "$TEST_DIR"
    CLONE_DIR="${VOLUME_NAME}-clone"
    run $CLI_COMMAND volume clone "$VOLUME_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Successfully cloned"
    assert_output --partial "$VOLUME_NAME"

    echo "# Step 3: Verify cloned files"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/hello.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/hello.txt"
    assert_output "hello from volume"
}

# ============================================
# Empty Storage Clone Tests
# ============================================

@test "vm0 artifact clone handles empty artifact" {
    echo "# Step 1: Create and push empty artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone empty artifact"
    cd "$TEST_DIR"
    CLONE_DIR="${ARTIFACT_NAME}-empty"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "empty"

    echo "# Step 3: Verify directory created with config"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]
}

@test "vm0 volume clone handles empty volume" {
    echo "# Step 1: Create and push empty volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Clone empty volume"
    cd "$TEST_DIR"
    CLONE_DIR="${VOLUME_NAME}-empty"
    run $CLI_COMMAND volume clone "$VOLUME_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "empty"

    echo "# Step 3: Verify directory created with config"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]
}
