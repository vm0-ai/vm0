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
    # Create directory with volume name for auto-detection
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"

    run $CLI_COMMAND volume init
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
    # Create directory with invalid name (uppercase)
    mkdir -p "$TEST_VOLUME_DIR/INVALID_NAME"
    cd "$TEST_VOLUME_DIR/INVALID_NAME"

    run $CLI_COMMAND volume init
    assert_failure
    assert_output --partial "Invalid volume name"
}

@test "Push volume to cloud" {
    # Create directory with volume name and initialize
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"

    # Initialize volume
    $CLI_COMMAND volume init >/dev/null

    # Create test files
    echo "Hello from E2E test" > test-file.txt
    mkdir -p data
    echo "42" > data/answer.txt

    # Push to cloud
    run $CLI_COMMAND volume push
    assert_success
    assert_output --partial "Uploading"
    assert_output --partial "$VOLUME_NAME"
}

@test "Pull volume from cloud" {
    # Test pull in a different directory
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"

    # Create .vm0/volume.yaml config to specify which volume to pull
    mkdir -p .vm0
    cat > .vm0/volume.yaml <<'EOF'
name: e2e-test-volume
EOF

    run $CLI_COMMAND volume pull
    assert_success
    assert_output --partial "Downloading"

    # Verify files exist
    [ -f "test-file.txt" ]
    [ -f "data/answer.txt" ]

    rm -rf "$NEW_DIR"
}

@test "Run agent with vm0:// volume - read uploaded file" {
    # Build the agent config first
    $CLI_COMMAND build "$TEST_VM0_VOLUME_CONFIG" >/dev/null

    # Note: This test depends on the previous push succeeding
    run $CLI_COMMAND run vm0-test-vm0-volume \
        "Read the file at /workspace/test-file.txt and tell me exactly what it says"

    assert_success
    assert_output --partial "Hello from E2E test"
}
