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

# ============================================
# Volume CLI Operations (no vm0 run needed)
# ============================================

@test "Initialize volume in directory" {
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
    # Verify versionId is returned (UUID format)
    assert_output --partial "Version:"
    assert_output --regexp "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
}

@test "Multiple pushes create different versions" {
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # First push
    echo "version 1" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f-]+')

    # Second push with different content
    echo "version 2" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version: \K[0-9a-f-]+')

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
    cat > .vm0/volume.yaml <<EOF
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

# ============================================
# Agent with vm0:// volume (single vm0 run)
# This test verifies both volume mounting AND version (HEAD) behavior
# ============================================

@test "Agent reads HEAD version from vm0:// volume" {
    # Create and push multiple versions to test HEAD behavior
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Push first version (will be overwritten)
    echo "old content - should not see this" > message.txt
    $CLI_COMMAND volume push >/dev/null

    # Push second version (becomes HEAD)
    echo "Hello from HEAD version" > message.txt
    echo "42" > answer.txt
    $CLI_COMMAND volume push >/dev/null

    # Create agent config that uses this volume
    CONFIG_DIR="$(mktemp -d)"
    cat > "$CONFIG_DIR/test-config.yaml" <<EOF
version: "1.0"

agent:
  name: test-vm0-volume-$VOLUME_NAME
  description: "Test agent with VM0 volume"
  image: vm0-claude-code-dev
  provider: claude-code
  working_dir: /workspace
  volumes:
    - test-data:/workspace

volumes:
  test-data:
    driver: vm0
    driver_opts:
      uri: vm0://$VOLUME_NAME
EOF

    cd "$CONFIG_DIR"
    $CLI_COMMAND build test-config.yaml >/dev/null

    # Run agent - should see HEAD version content (verifies both mounting and versioning)
    run $CLI_COMMAND run "test-vm0-volume-$VOLUME_NAME" \
        "cat /workspace/message.txt && cat /workspace/answer.txt"

    assert_success
    # Verify HEAD version content (not old content)
    assert_output --partial "Hello from HEAD version"
    assert_output --partial "42"

    rm -rf "$CONFIG_DIR"
}
