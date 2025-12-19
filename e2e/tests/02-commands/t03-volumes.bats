#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_VOLUME_DIR="$(mktemp -d)"
    # Use unique test volume name with timestamp to avoid conflicts
    export VOLUME_NAME="e2e-test-volume-$(date +%s)"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}

@test "Initialize volume in directory" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"

    run $CLI_COMMAND volume init
    assert_success
    assert_output --partial "$VOLUME_NAME"

    # Verify .vm0/storage.yaml file is created
    [ -f ".vm0/storage.yaml" ]
}

@test "Initialize volume with auto-detected name" {
    mkdir -p "$TEST_VOLUME_DIR/my-dataset"
    cd "$TEST_VOLUME_DIR/my-dataset"
    run $CLI_COMMAND volume init
    assert_success
    assert_output --partial "my-dataset"
}

@test "volume init rejects invalid volume name" {
    mkdir -p "$TEST_VOLUME_DIR/INVALID_NAME"
    cd "$TEST_VOLUME_DIR/INVALID_NAME"

    run $CLI_COMMAND volume init
    assert_failure
    assert_output --partial "Invalid volume name"
}

@test "Push empty volume to cloud succeeds" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Push without any files (empty volume)
    run $CLI_COMMAND volume push
    assert_success
    assert_output --partial "No files found (empty volume)"
    assert_output --partial "Version:"
    assert_output --partial "Files: 0"
    assert_output --regexp "[0-9a-f]{8}"
}

@test "Push volume to cloud and returns versionId" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "Hello from E2E test" > test-file.txt
    mkdir -p data
    echo "42" > data/answer.txt

    run $CLI_COMMAND volume push
    assert_success
    assert_output --partial "Uploading"
    assert_output --partial "$VOLUME_NAME"
    # Verify versionId is returned (SHA-256 format - 64 hex chars, displayed as 8 char short version)
    assert_output --partial "Version:"
    assert_output --regexp "[0-9a-f]{8}"
}

@test "Multiple pushes create different versions" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # First push
    echo "version 1" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Second push with different content
    echo "version 2" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Versions should be different
    [ "$VERSION1" != "$VERSION2" ]
}

@test "Pull volume from cloud gets HEAD version" {
    # First push multiple versions
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "version 1" > data.txt
    $CLI_COMMAND volume push >/dev/null

    echo "version 2" > data.txt
    $CLI_COMMAND volume push >/dev/null

    echo "version 3 - HEAD" > data.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt
    $CLI_COMMAND volume push >/dev/null

    # Pull in a different directory
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $VOLUME_NAME
EOF

    run $CLI_COMMAND volume pull
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
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Push version 1
    echo "content from version 1" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')

    # Push version 2
    echo "content from version 2" > data.txt
    run $CLI_COMMAND volume push
    assert_success

    # Push version 3 (HEAD)
    echo "content from version 3 - HEAD" > data.txt
    run $CLI_COMMAND volume push
    assert_success

    # Pull version 1 specifically (not HEAD)
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $VOLUME_NAME
EOF

    run $CLI_COMMAND volume pull "$VERSION1"
    assert_success
    assert_output --partial "version: $VERSION1"

    # Verify we got version 1 content (not HEAD)
    [ -f "data.txt" ]
    run cat data.txt
    assert_output "content from version 1"

    rm -rf "$NEW_DIR"
}

@test "Pull non-existent version fails with error" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "some content" > data.txt
    $CLI_COMMAND volume push >/dev/null

    # Try to pull a non-existent version
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/storage.yaml <<EOF
name: $VOLUME_NAME
EOF

    # Use a valid-looking SHA-256 hash that doesn't exist (minimum 8 chars for short version)
    FAKE_VERSION="00000000"
    run $CLI_COMMAND volume pull "$FAKE_VERSION"
    assert_failure
    assert_output --partial "not found"

    rm -rf "$NEW_DIR"
}

@test "volume status fails without init" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"

    # No .vm0/storage.yaml exists
    run $CLI_COMMAND volume status
    assert_failure
    assert_output --partial "No volume initialized"
    assert_output --partial "vm0 volume init"
}

@test "volume status fails when not pushed to remote" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Init but no push - remote doesn't exist
    run $CLI_COMMAND volume status
    assert_failure
    assert_output --partial "Checking volume"
    assert_output --partial "Not found on remote"
    assert_output --partial "vm0 volume push"
}

@test "volume status shows version info after push" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "# Step 1: Push volume..."
    echo "test content" > test-file.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Check status..."
    run $CLI_COMMAND volume status
    assert_success
    assert_output --partial "Checking volume"
    assert_output --partial "Found"
    assert_output --partial "Version:"
    assert_output --partial "Files:"
    assert_output --partial "Size:"
    assert_output --regexp "[0-9a-f]{8}"
}

@test "volume status shows empty indicator for empty volume" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "# Step 1: Push empty volume..."
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Check status..."
    run $CLI_COMMAND volume status
    assert_success
    assert_output --partial "Checking volume"
    assert_output --partial "Found (empty)"
    assert_output --partial "Version:"
} 