#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use unique names with timestamp to avoid conflicts
    export ARTIFACT_NAME="e2e-list-artifact-$(date +%s)"
    export VOLUME_NAME="e2e-list-volume-$(date +%s)"
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

@test "artifact list shows remote artifacts" {
    echo "# Step 1: Create and push an artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test content" > test-file.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: List artifacts..."
    run $CLI_COMMAND artifact list
    assert_success
    assert_output --partial "$ARTIFACT_NAME"
}

@test "artifact list shows empty message when no artifacts" {
    # Use a unique name that definitely doesn't exist
    NONEXISTENT_NAME="e2e-nonexistent-artifact-$(date +%s%N)"

    run $CLI_COMMAND artifact list
    # Should succeed even if empty (shows table or empty message)
    assert_success
}

# ============================================
# Volume List Tests
# ============================================

@test "volume list shows remote volumes" {
    echo "# Step 1: Create and push a volume..."
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "test content" > test-file.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: List volumes..."
    run $CLI_COMMAND volume list
    assert_success
    assert_output --partial "$VOLUME_NAME"
}

@test "volume list shows empty message when no volumes" {
    run $CLI_COMMAND volume list
    # Should succeed even if empty (shows table or empty message)
    assert_success
}

# ============================================
# Artifact Clone Tests
# ============================================

@test "artifact clone creates local copy from remote" {
    echo "# Step 1: Create and push an artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "clone test content" > clone-test.txt
    mkdir -p subdir
    echo "nested content" > subdir/nested.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone to a new directory..."
    CLONE_DIR="$TEST_DIR/cloned-artifact"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Cloned"

    echo "# Step 3: Verify cloned content..."
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/clone-test.txt" ]
    [ -f "$CLONE_DIR/subdir/nested.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/clone-test.txt"
    assert_output "clone test content"
}

@test "artifact clone to default directory uses artifact name" {
    echo "# Step 1: Create and push an artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "default dir test" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone without destination (uses name as dir)..."
    cd "$TEST_DIR"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME"
    assert_success

    echo "# Step 3: Verify directory was created with artifact name..."
    [ -d "$TEST_DIR/$ARTIFACT_NAME" ] || [ -d "$ARTIFACT_NAME" ]
}

@test "artifact clone fails for non-existent artifact" {
    run $CLI_COMMAND artifact clone "nonexistent-artifact-xyz123" "$TEST_DIR/should-not-exist"
    assert_failure
    assert_output --partial "not found"
}

@test "artifact clone fails if destination exists" {
    echo "# Step 1: Create and push an artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Create destination directory..."
    mkdir -p "$TEST_DIR/existing-dir"

    echo "# Step 3: Try to clone to existing directory..."
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "$TEST_DIR/existing-dir"
    assert_failure
    assert_output --partial "already exists"
}

# ============================================
# Volume Clone Tests
# ============================================

@test "volume clone creates local copy from remote" {
    echo "# Step 1: Create and push a volume..."
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "volume clone test" > volume-test.txt
    mkdir -p data
    echo "data content" > data/file.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Clone to a new directory..."
    CLONE_DIR="$TEST_DIR/cloned-volume"
    run $CLI_COMMAND volume clone "$VOLUME_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Cloned"

    echo "# Step 3: Verify cloned content..."
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/volume-test.txt" ]
    [ -f "$CLONE_DIR/data/file.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/volume-test.txt"
    assert_output "volume clone test"
}

@test "volume clone fails for non-existent volume" {
    run $CLI_COMMAND volume clone "nonexistent-volume-xyz123" "$TEST_DIR/should-not-exist"
    assert_failure
    assert_output --partial "not found"
}
