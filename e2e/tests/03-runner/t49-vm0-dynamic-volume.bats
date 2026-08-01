#!/usr/bin/env bats

# Test direct-run dynamic volume mounting (E2E happy path only).
# Additional volumes can be mounted without appearing in the compose config.

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
    seed_storage_fixture volume "$CLAUDE_VOLUME_NAME" . >/dev/null
    cd - >/dev/null

    # Create dynamic volume A with known content
    export DYNAMIC_VOL_A="e2e-vol-t49-dyn-a-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$DYNAMIC_VOL_A"
    cd "$TEST_DIR/$DYNAMIC_VOL_A"
    echo "dynamic-content-a" > data.txt
    seed_storage_fixture volume "$DYNAMIC_VOL_A" . >/dev/null
    cd - >/dev/null

    # Create dynamic volume B with different content
    export DYNAMIC_VOL_B="e2e-vol-t49-dyn-b-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$DYNAMIC_VOL_B"
    cd "$TEST_DIR/$DYNAMIC_VOL_B"
    echo "dynamic-content-b" > data.txt
    seed_storage_fixture volume "$DYNAMIC_VOL_B" . >/dev/null
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
volumes:
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests
    seed_compose_fixture "$TEST_CONFIG" >/dev/null
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

@test "t49-2: --volume mounts dynamic volume at runtime (latest)" {
    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    echo "test" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Run with an additional volume not present in the compose config.
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
cat /home/user/data/data.txt" \
        "$(jq -nc --arg artifact "$ARTIFACT_NAME" --arg volume "$DYNAMIC_VOL_A" \
            '{
                artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}],
                additionalVolumes: [{name: $volume, mountPath: "/home/user/data"}]
            }')"

    assert_success
    assert_output --partial "dynamic-content-a"
}

@test "t49-3: --volume with specific version" {
    # Push version 1 with v1-specific content
    cd "$TEST_DIR/$DYNAMIC_VOL_A"
    echo "v1-content" > data.txt
    run seed_storage_fixture volume "$DYNAMIC_VOL_A" .
    assert_success
    VERSION1="$output"
    [ -n "$VERSION1" ]

    # Push version 2 (HEAD) with different content
    echo "v2-head-content" > data.txt
    run seed_storage_fixture volume "$DYNAMIC_VOL_A" .
    assert_success

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    echo "test" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Run with specific version — should see v1 content, not HEAD
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
cat /home/user/data/data.txt" \
        "$(jq -nc \
            --arg artifact "$ARTIFACT_NAME" \
            --arg volume "$DYNAMIC_VOL_A" \
            --arg version "$VERSION1" \
            '{
                artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}],
                additionalVolumes: [{name: $volume, version: $version, mountPath: "/home/user/data"}]
            }')"

    assert_success
    assert_output --partial "v1-content"
    refute_output --partial "v2-head-content"
}

@test "t49-4: multiple --volume flags mount multiple volumes" {
    # Push fresh content to vol-a (t49-3 changed its HEAD)
    cd "$TEST_DIR/$DYNAMIC_VOL_A"
    echo "multi-test-a" > data.txt
    run seed_storage_fixture volume "$DYNAMIC_VOL_A" .
    assert_success

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    echo "test" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Run with two dynamic volumes at different mount paths
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
cat /home/user/data-a/data.txt && cat /home/user/data-b/data.txt" \
        "$(jq -nc \
            --arg artifact "$ARTIFACT_NAME" \
            --arg volumeA "$DYNAMIC_VOL_A" \
            --arg volumeB "$DYNAMIC_VOL_B" \
            '{
                artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}],
                additionalVolumes: [
                    {name: $volumeA, mountPath: "/home/user/data-a"},
                    {name: $volumeB, mountPath: "/home/user/data-b"}
                ]
            }')"

    assert_success
    assert_output --partial "multi-test-a"
    assert_output --partial "dynamic-content-b"
}
