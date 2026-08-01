#!/usr/bin/env bats

# Test direct-run volume version overrides (E2E happy path only).

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file - must be generated in setup_file()
    # and exported to persist across test cases
    export AGENT_NAME="e2e-t07-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique claude-files volume for this test file
    export CLAUDE_VOLUME_NAME="e2e-vol-t07-claude-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$CLAUDE_VOLUME_NAME"
    cd "$TEST_DIR/$CLAUDE_VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    seed_storage_fixture volume "$CLAUDE_VOLUME_NAME" . >/dev/null
    cd - >/dev/null

    # Create the test-volume that will be used for all override tests
    # This volume must exist before composing the agent
    export TEST_VOLUME_NAME="e2e-vol-t07-data-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$TEST_VOLUME_NAME"
    cd "$TEST_DIR/$TEST_VOLUME_NAME"
    echo "initial-data" > data.txt
    seed_storage_fixture volume "$TEST_VOLUME_NAME" . >/dev/null
    cd - >/dev/null

    # Create inline config with unique agent name using real volume names
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Test agent with volume for override testing"
    framework: claude-code
    volumes:
      - test-volume:/home/user/data
      - claude-files:/home/user/.config/claude
volumes:
  test-volume:
    name: $TEST_VOLUME_NAME
    version: latest
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    seed_compose_fixture "$TEST_CONFIG" >/dev/null
}

setup() {
    # Per-test setup: create unique artifact name
    # VOLUME_ALIAS is the key in the config's volumes section.
    # VOLUME_DIR is the actual directory path for the volume
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export VOLUME_ALIAS="test-volume"
    export VOLUME_DIR="$TEST_DIR/$TEST_VOLUME_NAME"
    export ARTIFACT_NAME="e2e-art-override-${UNIQUE_ID}"
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t07-2: volume version override selects an older version" {
    # Single direct run - safe for 30s timeout.

    # Step 1: Push multiple versions to the shared test volume
    echo "# Pushing multiple versions to shared test volume..."
    cd "$VOLUME_DIR"

    # Version 1: content = "version-1"
    echo "version-1" > data.txt
    run seed_storage_fixture volume "$TEST_VOLUME_NAME" .
    assert_success
    VERSION1="$output"
    echo "# Version 1 ID: $VERSION1"
    [ -n "$VERSION1" ]

    # Version 2: content = "version-2"
    echo "version-2" > data.txt
    run seed_storage_fixture volume "$TEST_VOLUME_NAME" .
    assert_success

    # Version 3 (HEAD): content = "version-3-head"
    echo "version-3-head" > data.txt
    run seed_storage_fixture volume "$TEST_VOLUME_NAME" .
    assert_success
    echo "# HEAD version pushed"

    # Step 2: Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    echo "test" > marker.txt
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    # Step 3: Override the compose volume alias to version 1 (~15s).
    echo "# Running agent with volume version override..."
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
cat /home/user/data/data.txt" \
        "$(jq -nc \
            --arg artifactName "$ARTIFACT_NAME" \
            --arg volumeAlias "$VOLUME_ALIAS" \
            --arg version "$VERSION1" \
            '{
                artifacts: [{name: $artifactName, mountPath: "/home/user/workspace"}],
                volumeVersions: {($volumeAlias): $version}
            }')"

    assert_success
    assert_output --partial '"name":"Bash"'

    # Should see version-1 content (the overridden version)
    assert_output --partial "version-1"

    # Should NOT see HEAD content
    refute_output --partial "version-3-head"

    echo "# Verified: volume override selected version 1"
}
