#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_VOLUME_DIR="$(mktemp -d)"
    # Use unique test volume name with timestamp
    export VOLUME_NAME="e2e-version-test-$(date +%s)"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}

@test "Push returns versionId in output" {
    # Create and initialize volume
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Create test file
    echo "version 1" > data.txt

    # Push and check for versionId in output
    run $CLI_COMMAND volume push
    assert_success
    assert_output --partial "Version:"
    # UUID format check (basic)
    assert_output --regexp "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
}

@test "Multiple pushes create different versions" {
    # Create and initialize volume
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

@test "Pull always gets HEAD version (latest)" {
    # Create and initialize volume
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # First version
    echo "version 1" > data.txt
    $CLI_COMMAND volume push >/dev/null

    # Second version (becomes HEAD)
    echo "version 2" > data.txt
    $CLI_COMMAND volume push >/dev/null

    # Third version (becomes new HEAD)
    echo "version 3" > data.txt
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

    # Should get version 3 (HEAD)
    run cat data.txt
    assert_success
    assert_output "version 3"

    rm -rf "$NEW_DIR"
}

@test "Volume versions persist across multiple pushes" {
    # Create and initialize volume
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Push 5 versions
    for i in {1..5}; do
        echo "version $i" > data.txt
        echo "file $i" > "file-$i.txt"
        $CLI_COMMAND volume push >/dev/null
    done

    # Pull should get version 5
    NEW_DIR="$(mktemp -d)"
    cd "$NEW_DIR"
    mkdir -p .vm0
    cat > .vm0/volume.yaml <<EOF
name: $VOLUME_NAME
EOF

    run $CLI_COMMAND volume pull
    assert_success

    # Check for version 5 files
    [ -f "data.txt" ]
    [ -f "file-5.txt" ]
    run cat data.txt
    assert_output "version 5"

    rm -rf "$NEW_DIR"
}

@test "Agent reads HEAD version of vm0:// volume" {
    # Create test volume
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    # Push first version
    echo "old content" > message.txt
    $CLI_COMMAND volume push >/dev/null

    # Push second version (becomes HEAD)
    echo "new content from HEAD version" > message.txt
    $CLI_COMMAND volume push >/dev/null

    # Create agent config that uses this volume
    CONFIG_DIR="$(mktemp -d)"
    cat > "$CONFIG_DIR/test-config.yaml" <<EOF
version: "1.0"

agent:
  name: test-volume-version
  description: "Test agent with versioned VM0 volume"
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

    # Build config
    cd "$CONFIG_DIR"
    $CLI_COMMAND build test-config.yaml >/dev/null

    # Run agent - should see HEAD version content
    # Use the agent name from config, not the filename
    run $CLI_COMMAND run test-volume-version \
        "Read the file /workspace/message.txt and tell me exactly what it says"

    assert_success
    assert_output --partial "new content from HEAD version"

    rm -rf "$CONFIG_DIR"
}
