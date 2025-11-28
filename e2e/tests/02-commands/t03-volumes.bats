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