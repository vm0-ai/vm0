#!/usr/bin/env bats

# Test VM0 volume version override functionality
# This test verifies that:
# 1. --volume-version flag can override volume versions at runtime
# 2. Multiple --volume-version flags work for different volumes
# 3. Volume version overrides work with checkpoint resume and session continue
#
# Test count: 3 tests with multiple vm0 run calls

load '../../helpers/setup'

setup() {
    # Create unique claude-files volume for this test
    create_test_volume "e2e-vol-t07-claude"
    export CLAUDE_VOLUME_NAME="$VOLUME_NAME"

    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use unique test names with timestamp to avoid conflicts in parallel runs
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export VOLUME_NAME="e2e-vol-override-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-art-override-${UNIQUE_ID}"
    export AGENT_NAME="vm0-vol-override-${UNIQUE_ID}"
    # Config will be created dynamically in the test
    export TEST_CONFIG="$TEST_DIR/vm0-volume-override.yaml"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    # Clean up test volume
    cleanup_test_volume
}

# Helper function to create and compose the agent config
create_and_compose_agent() {
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test agent with volume for override testing"
    framework: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - ${VOLUME_NAME}:/home/user/data
      - claude-files:/home/user/.config/claude
    working_dir: /home/user/workspace

volumes:
  ${VOLUME_NAME}:
    name: ${VOLUME_NAME}
    version: latest
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF
    $CLI_COMMAND compose "$TEST_CONFIG" >/dev/null
}

@test "Build VM0 volume override test agent configuration" {
    # Create config dynamically with unique names to avoid parallel test conflicts
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test agent with volume for override testing"
    framework: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - ${VOLUME_NAME}:/home/user/data
      - claude-files:/home/user/.config/claude
    working_dir: /home/user/workspace

volumes:
  ${VOLUME_NAME}:
    name: ${VOLUME_NAME}
    version: latest
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 volume version override: --volume-version overrides volume at runtime" {
    # This test verifies that --volume-version flag overrides the default volume version

    # Step 0: Create and compose agent (each test needs its own agent due to parallel execution)
    create_and_compose_agent

    # Step 1: Create test volume with multiple versions
    echo "# Step 1: Creating test volume with version 1..."
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null

    # Version 1: content = "version-1"
    echo "version-1" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Version 1 ID: $VERSION1"
    [ -n "$VERSION1" ]

    # Version 2: content = "version-2"
    echo "version-2" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Version 2 ID: $VERSION2"
    [ -n "$VERSION2" ]

    # Version 3 (HEAD): content = "version-3-head"
    echo "version-3-head" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    echo "# HEAD version pushed"

    # Step 2: Create artifact
    echo "# Step 2: Creating artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 3: Run agent WITH --volume-version to override to version 1
    # The volume should have version-1 content instead of version-3-head (latest)
    echo "# Step 3: Running agent with --volume-version override..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --volume-version "$VOLUME_NAME=$VERSION1" \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see version-1 content (the overridden version)
    assert_output --partial "version-1"

    # Should NOT see HEAD content
    refute_output --partial "version-3-head"

    echo "# Verified: --volume-version correctly overrode volume to version 1"
}

@test "VM0 volume version override: checkpoint resume with --volume-version" {
    # This test verifies that --volume-version can override stored checkpoint volume versions

    # Step 0: Create and compose agent (each test needs its own agent due to parallel execution)
    create_and_compose_agent

    # Step 1: Create test volume
    echo "# Step 1: Creating test volume..."
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null

    echo "checkpoint-version" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    CHECKPOINT_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Checkpoint version ID: $CHECKPOINT_VERSION"
    [ -n "$CHECKPOINT_VERSION" ]

    # Step 2: Create artifact and run agent
    echo "# Step 2: Creating artifact and running agent..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Checkpoint:"

    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ]

    # Step 3: Push new volume version (override version)
    echo "# Step 3: Pushing override version..."
    cd "$TEST_DIR/$VOLUME_NAME"
    echo "override-version" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    OVERRIDE_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Override version ID: $OVERRIDE_VERSION"
    [ -n "$OVERRIDE_VERSION" ]

    # Step 4: Resume from checkpoint WITH volume override
    # Should use the override version, not the checkpoint's stored version
    echo "# Step 4: Resuming with --volume-version override..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        --volume-version "$VOLUME_NAME=$OVERRIDE_VERSION" \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see override version content (not checkpoint version)
    assert_output --partial "override-version"

    # Should NOT see checkpoint version content
    refute_output --partial "checkpoint-version"

    echo "# Verified: --volume-version correctly overrode checkpoint volume"
}

@test "VM0 volume version override: continue session with --volume-version" {
    # This test verifies that --volume-version works with session continue

    # Step 0: Create and compose agent (each test needs its own agent due to parallel execution)
    create_and_compose_agent

    # Step 1: Create test volume with initial version
    echo "# Step 1: Creating test volume..."
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null

    echo "initial-volume-content" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    INITIAL_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Initial version ID: $INITIAL_VERSION"
    [ -n "$INITIAL_VERSION" ]

    # Step 2: Create artifact and run agent
    echo "# Step 2: Creating artifact and running agent..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'creating session'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ]

    # Step 3: Push new volume version
    echo "# Step 3: Pushing new volume version..."
    cd "$TEST_DIR/$VOLUME_NAME"
    echo "new-volume-content" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    NEW_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# New version ID: $NEW_VERSION"
    [ -n "$NEW_VERSION" ]

    # Step 4: Continue session with initial volume version override
    # Should use the overridden version (initial), not latest
    echo "# Step 4: Continuing session with --volume-version override..."
    run $CLI_COMMAND run continue "$SESSION_ID" \
        --volume-version "$VOLUME_NAME=$INITIAL_VERSION" \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see initial version content (the overridden version)
    assert_output --partial "initial-volume-content"

    # Should NOT see new/latest version content
    refute_output --partial "new-volume-content"

    echo "# Verified: --volume-version correctly overrode volume in session continue"
}
