#!/usr/bin/env bats

# Test VM0 dynamic volume mounting via --volume flag (E2E happy path only)
# This test verifies that --volume flag can mount volumes that are not defined
# in the agent's compose configuration.
#
# Note: resume/continue with --volume uses the same code path and is tested
# via CLI Command Integration Tests (see run/__tests__/dynamic-volume.test.ts).

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t49-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create claude-files volume (required for agent to run)
    export CLAUDE_VOLUME_NAME="e2e-vol-t49-claude-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$CLAUDE_VOLUME_NAME"
    cd "$TEST_DIR/$CLAUDE_VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$CLAUDE_VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create dynamic volume A with known content
    export DYNAMIC_VOL_A="e2e-vol-t49-dyn-a-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$DYNAMIC_VOL_A"
    cd "$TEST_DIR/$DYNAMIC_VOL_A"
    echo "dynamic-content-a" > data.txt
    $VM0_CLI volume init --name "$DYNAMIC_VOL_A" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create dynamic volume B with different content
    export DYNAMIC_VOL_B="e2e-vol-t49-dyn-b-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$DYNAMIC_VOL_B"
    cd "$TEST_DIR/$DYNAMIC_VOL_B"
    echo "dynamic-content-b" > data.txt
    $VM0_CLI volume init --name "$DYNAMIC_VOL_B" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create inline config — agent has NO volumes except claude-files
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Test agent for dynamic volume mounting"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.config/claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-art-dynvol-${UNIQUE_ID}"
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t49-1: build agent configuration" {
    run $VM0_CLI compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t49-2: --volume mounts dynamic volume at runtime (latest)" {
    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $VM0_CLI artifact push
    assert_success

    # Run agent with --volume pointing to a volume NOT in compose config
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME" \
        --volume "$DYNAMIC_VOL_A:/home/user/data" \
        --verbose \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "dynamic-content-a"
}

@test "t49-3: --volume with specific version" {
    # Push version 1 with v1-specific content
    cd "$TEST_DIR/$DYNAMIC_VOL_A"
    echo "v1-content" > data.txt
    run $VM0_CLI volume push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    [ -n "$VERSION1" ]

    # Push version 2 (HEAD) with different content
    echo "v2-head-content" > data.txt
    run $VM0_CLI volume push
    assert_success

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $VM0_CLI artifact push
    assert_success

    # Run with specific version — should see v1 content, not HEAD
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME" \
        --volume "$DYNAMIC_VOL_A:$VERSION1:/home/user/data" \
        --verbose \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "v1-content"
    refute_output --partial "v2-head-content"
}

@test "t49-4: multiple --volume flags mount multiple volumes" {
    # Push fresh content to vol-a (t49-3 changed its HEAD)
    cd "$TEST_DIR/$DYNAMIC_VOL_A"
    echo "multi-test-a" > data.txt
    run $VM0_CLI volume push
    assert_success

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $VM0_CLI artifact push
    assert_success

    # Run with two dynamic volumes at different mount paths
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME" \
        --volume "$DYNAMIC_VOL_A:/home/user/data-a" \
        --volume "$DYNAMIC_VOL_B:/home/user/data-b" \
        --verbose \
        "cat /home/user/data-a/data.txt && cat /home/user/data-b/data.txt"

    assert_success
    assert_output --partial "multi-test-a"
    assert_output --partial "dynamic-content-b"
}
