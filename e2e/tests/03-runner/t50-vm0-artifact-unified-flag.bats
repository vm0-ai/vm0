#!/usr/bin/env bats

# Test direct artifact overrides with explicit versions (E2E happy path only).

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t50-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume for claude-files and compose ONCE
    create_test_volume "e2e-vol-t50"
    export SHARED_VOLUME_NAME="$VOLUME_NAME"
    export SHARED_VOLUME_DIR="$TEST_VOLUME_DIR"

    export SHARED_CONFIG="$TEST_DIR/vm0.yaml"
    cat > "$SHARED_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for unified artifact flag"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $SHARED_VOLUME_NAME
    version: latest
EOF
    seed_compose_fixture "$SHARED_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    if [ -n "$SHARED_VOLUME_DIR" ] && [ -d "$SHARED_VOLUME_DIR" ]; then
        rm -rf "$SHARED_VOLUME_DIR"
    fi
}

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-art-t50-$(date +%s%3N)-$RANDOM"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "t50-1: --artifact name mounts latest artifact" {
    # Step 1: Create and push artifact with known content
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "unified-flag-content" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Step 2: Run with an artifact name only, which resolves to latest.
    run run_compose_fixture "$AGENT_NAME" \
        "cat /home/user/workspace/marker.txt" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"

    assert_success
    assert_output --partial "unified-flag-content"
}

@test "t50-2: --artifact name:version mounts specific version" {
    # Step 1: Push version 1
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "version-1-content" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success
    VERSION1="$output"
    echo "# Version 1 ID: $VERSION1"
    [ -n "$VERSION1" ]

    # Step 2: Push version 2 (becomes HEAD)
    echo "version-2-head" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success
    echo "# HEAD version pushed"

    # Step 3: Run agent with --artifact name:version to pin to version 1
    run run_compose_fixture "$AGENT_NAME" \
        "cat /home/user/workspace/marker.txt" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" --arg version "$VERSION1" \
            '{artifacts: [{name: $name, version: $version, mountPath: "/home/user/workspace"}]}')"

    assert_success

    # Should see version-1 content (the pinned version)
    assert_output --partial "version-1-content"

    # Should NOT see HEAD content
    refute_output --partial "version-2-head"

    echo "# Verified: --artifact name:version correctly pinned to version 1"
}
