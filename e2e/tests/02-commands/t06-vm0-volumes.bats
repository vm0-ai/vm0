#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_VOLUME_DIR="$(mktemp -d)"
    # Use fixed test volume name
    export VOLUME_NAME="e2e-test-volume"

    # Config file path
    export TEST_VM0_VOLUME_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-vm0-volume.yaml"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}

@test "Initialize volume in directory" {
    cd "$TEST_VOLUME_DIR"
    run $CLI_COMMAND volume init "$VOLUME_NAME"
    assert_success
    assert_output --partial "$VOLUME_NAME"

    # Verify .vm0/volume.yaml file is created
    [ -f ".vm0/volume.yaml" ]
}

@test "Initialize volume with auto-detected name" {
    mkdir -p "$TEST_VOLUME_DIR/my-dataset"
    cd "$TEST_VOLUME_DIR/my-dataset"
    run $CLI_COMMAND volume init
    assert_success
    assert_output --partial "my-dataset"
}

@test "volume init rejects invalid volume name" {
    cd "$TEST_VOLUME_DIR"
    run $CLI_COMMAND volume init "INVALID_NAME"
    assert_failure
    assert_output --partial "Invalid volume name"
}

@test "Push volume to cloud" {
    cd "$TEST_VOLUME_DIR"

    # Initialize volume
    $CLI_COMMAND volume init "$VOLUME_NAME" >/dev/null

    # Create test files
    echo "Hello from E2E test" > test-file.txt
    mkdir -p data
    echo "42" > data/answer.txt

    # Push to cloud
    run $CLI_COMMAND volume push
    assert_success
    assert_output --partial "Uploading volume"
    assert_output --partial "$VOLUME_NAME"
}

@test "Pull volume from cloud" {
    # Test pull in a different directory
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"

    run $CLI_COMMAND volume pull "$VOLUME_NAME"
    assert_success
    assert_output --partial "Downloading"

    # Verify files exist
    [ -f "test-file.txt" ]
    [ -f "data/answer.txt" ]

    rm -rf "$NEW_DIR"
}

@test "Run agent with vm0:// volume - read uploaded file" {
    # Note: This test depends on the previous push succeeding
    run $CLI_COMMAND run vm0-test-vm0-volume \
        "Read the file at /workspace/test-file.txt and tell me exactly what it says"

    assert_success
    assert_output --partial "Hello from E2E test"
}
