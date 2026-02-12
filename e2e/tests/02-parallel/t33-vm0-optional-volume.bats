#!/usr/bin/env bats

# Test VM0 optional volume functionality
# This test verifies that volumes marked as optional: true can be missing at runtime
# without causing run failures.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t33-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create a claude-files volume that exists (required for claude-code framework)
    export CLAUDE_VOLUME_NAME="e2e-vol-t33-claude-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$CLAUDE_VOLUME_NAME"
    cd "$TEST_DIR/$CLAUDE_VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $CLI_COMMAND volume init --name "$CLAUDE_VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null

    # Unique name for the optional volume that will NOT exist
    export OPTIONAL_VOLUME_NAME="e2e-vol-t33-optional-nonexistent-$(date +%s%3N)-$RANDOM"
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

setup() {
    # Per-test setup
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-art-optional-${UNIQUE_ID}"
}

@test "t33-1: compose succeeds with optional volume that does not exist" {
    # Create config with optional volume that doesn't exist
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Test agent with optional volume"
    framework: claude-code
    volumes:
      - optional-data:/home/user/optional-data
      - claude-files:/home/user/.config/claude
volumes:
  optional-data:
    name: $OPTIONAL_VOLUME_NAME
    version: latest
    optional: true
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t33-2: run succeeds when optional volume does not exist (skip silently)" {
    # Ensure config is created with optional volume
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Test agent with optional volume"
    framework: claude-code
    volumes:
      - optional-data:/home/user/optional-data
      - claude-files:/home/user/.config/claude
volumes:
  optional-data:
    name: $OPTIONAL_VOLUME_NAME
    version: latest
    optional: true
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    # Compose the agent
    $CLI_COMMAND compose "$TEST_CONFIG" >/dev/null

    # Create artifact (required for run)
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success
    cd - >/dev/null

    # Run agent - should succeed even though optional volume doesn't exist
    # The optional volume mount point should simply not exist
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "ls -la /home/user/optional-data 2>&1 || echo 'OPTIONAL_DIR_NOT_MOUNTED'"

    assert_success
    # The optional directory should not be mounted (volume doesn't exist)
    assert_output --partial "OPTIONAL_DIR_NOT_MOUNTED"
}

@test "t33-3: run succeeds with mixed volumes (required exists, optional missing)" {
    # Create a required volume that DOES exist
    export REQUIRED_VOLUME_NAME="e2e-vol-t33-required-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$REQUIRED_VOLUME_NAME"
    cd "$TEST_DIR/$REQUIRED_VOLUME_NAME"
    echo "required-data-content" > required.txt
    $CLI_COMMAND volume init --name "$REQUIRED_VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null

    # Create config with both required and optional volumes
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}-mixed:
    description: "Test agent with mixed volumes"
    framework: claude-code
    volumes:
      - required-data:/home/user/required-data
      - optional-data:/home/user/optional-data
      - claude-files:/home/user/.config/claude
volumes:
  required-data:
    name: $REQUIRED_VOLUME_NAME
    version: latest
  optional-data:
    name: $OPTIONAL_VOLUME_NAME
    version: latest
    optional: true
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Create artifact
    export ARTIFACT_NAME_MIXED="e2e-art-mixed-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME_MIXED"
    cd "$TEST_DIR/$ARTIFACT_NAME_MIXED"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME_MIXED" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success
    cd - >/dev/null

    # Run agent - should succeed with required volume mounted, optional skipped
    run $CLI_COMMAND run "${AGENT_NAME}-mixed" \
        --artifact-name "$ARTIFACT_NAME_MIXED" \
        --verbose \
        "cat /home/user/required-data/required.txt && (ls /home/user/optional-data 2>&1 || echo 'OPTIONAL_NOT_MOUNTED')"

    assert_success
    # Required volume should be mounted and readable
    assert_output --partial "required-data-content"
    # Optional volume should not be mounted
    assert_output --partial "OPTIONAL_NOT_MOUNTED"
}
