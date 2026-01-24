#!/usr/bin/env bats

# Test VM0 volume version override functionality
# This test verifies that:
# 1. --volume-version flag can override volume versions at runtime
# 2. Multiple --volume-version flags work for different volumes
# 3. Volume version overrides work with checkpoint resume and session continue
#
# Refactored to split multi-vm0-run tests into separate cases for timeout safety.
# Each case has max one vm0 run call (~15s), fitting within 30s timeout.
# State is shared between cases via $BATS_FILE_TMPDIR.

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
    $CLI_COMMAND volume init --name "$CLAUDE_VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null

    # Create the test-volume that will be used for all override tests
    # This volume must exist before composing the agent
    export TEST_VOLUME_NAME="e2e-vol-t07-data-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$TEST_VOLUME_NAME"
    cd "$TEST_DIR/$TEST_VOLUME_NAME"
    echo "initial-data" > data.txt
    $CLI_COMMAND volume init --name "$TEST_VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null

    # Create inline config with unique agent name using real volume names
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Test agent with volume for override testing"
    framework: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - test-volume:/home/user/data
      - claude-files:/home/user/.config/claude
    working_dir: /home/user/workspace
volumes:
  test-volume:
    name: $TEST_VOLUME_NAME
    version: latest
  claude-files:
    name: $CLAUDE_VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    $CLI_COMMAND compose "$TEST_CONFIG" >/dev/null
}

setup() {
    # Per-test setup: create unique artifact name
    # VOLUME_ALIAS is the key in the config's volumes section (used for --volume-version flag)
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

@test "t07-1: build agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t07-2: --volume-version overrides volume at runtime" {
    # This test verifies that --volume-version flag overrides the default volume version
    # Single vm0 run - safe for 30s timeout

    # Step 1: Push multiple versions to the shared test volume
    echo "# Pushing multiple versions to shared test volume..."
    cd "$VOLUME_DIR"

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

    # Version 3 (HEAD): content = "version-3-head"
    echo "version-3-head" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    echo "# HEAD version pushed"

    # Step 2: Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 3: Run agent WITH --volume-version to override to version 1 (~15s)
    # Note: --volume-version uses the volume ALIAS from config (test-volume), not the storage name
    echo "# Running agent with --volume-version override..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --volume-version "$VOLUME_ALIAS=$VERSION1" \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see version-1 content (the overridden version)
    assert_output --partial "version-1"

    # Should NOT see HEAD content
    refute_output --partial "version-3-head"

    echo "# Verified: --volume-version correctly overrode volume to version 1"
}

# ============================================================================
# Test 3: Checkpoint resume with --volume-version (split into 3a, 3b, 3c)
# ============================================================================

@test "t07-3a: create checkpoint for volume override test" {
    # Step 1: Push a version to the shared test volume
    echo "# Pushing checkpoint version to shared test volume..."
    cd "$VOLUME_DIR"

    echo "checkpoint-version" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    CHECKPOINT_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Checkpoint version ID: $CHECKPOINT_VERSION"
    [ -n "$CHECKPOINT_VERSION" ]

    # Step 2: Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 3: Run agent to create checkpoint (~15s)
    echo "# Running agent to create checkpoint..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Checkpoint:"

    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ]

    # Save state for next tests (use VOLUME_ALIAS for --volume-version, VOLUME_DIR for file access)
    echo "$CHECKPOINT_ID" > "$BATS_FILE_TMPDIR/t07-3-checkpoint_id"
    echo "$VOLUME_ALIAS" > "$BATS_FILE_TMPDIR/t07-3-volume_alias"
    echo "$VOLUME_DIR" > "$BATS_FILE_TMPDIR/t07-3-volume_dir"
}

@test "t07-3b: push override version for checkpoint test" {
    # Load state from previous test
    VOLUME_DIR=$(cat "$BATS_FILE_TMPDIR/t07-3-volume_dir")

    # Push new volume version (override version)
    echo "# Pushing override version..."
    cd "$VOLUME_DIR"
    echo "override-version" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    OVERRIDE_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Override version ID: $OVERRIDE_VERSION"
    [ -n "$OVERRIDE_VERSION" ]

    # Save for next test
    echo "$OVERRIDE_VERSION" > "$BATS_FILE_TMPDIR/t07-3-override_version"
}

@test "t07-3c: resume checkpoint with --volume-version override" {
    # Load state from previous tests
    CHECKPOINT_ID=$(cat "$BATS_FILE_TMPDIR/t07-3-checkpoint_id")
    VOLUME_ALIAS=$(cat "$BATS_FILE_TMPDIR/t07-3-volume_alias")
    OVERRIDE_VERSION=$(cat "$BATS_FILE_TMPDIR/t07-3-override_version")

    # Resume from checkpoint WITH volume override (~15s)
    # Note: --volume-version uses the volume ALIAS from config (test-volume), not the storage name
    echo "# Resuming with --volume-version override..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        --volume-version "$VOLUME_ALIAS=$OVERRIDE_VERSION" \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see override version content (not checkpoint version)
    assert_output --partial "override-version"

    # Should NOT see checkpoint version content
    refute_output --partial "checkpoint-version"

    echo "# Verified: --volume-version correctly overrode checkpoint volume"
}

# ============================================================================
# Test 4: Continue session with --volume-version (split into 4a, 4b, 4c)
# ============================================================================

@test "t07-4a: create session for volume override continue test" {
    # Step 1: Push initial version to the shared test volume
    echo "# Pushing initial version to shared test volume..."
    cd "$VOLUME_DIR"

    echo "initial-volume-content" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    INITIAL_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# Initial version ID: $INITIAL_VERSION"
    [ -n "$INITIAL_VERSION" ]

    # Step 2: Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > marker.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 3: Run agent to create session (~15s)
    echo "# Running agent to create session..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'creating session'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ]

    # Save state for next tests (use VOLUME_ALIAS for --volume-version, VOLUME_DIR for file access)
    echo "$SESSION_ID" > "$BATS_FILE_TMPDIR/t07-4-session_id"
    echo "$VOLUME_ALIAS" > "$BATS_FILE_TMPDIR/t07-4-volume_alias"
    echo "$INITIAL_VERSION" > "$BATS_FILE_TMPDIR/t07-4-initial_version"
    echo "$VOLUME_DIR" > "$BATS_FILE_TMPDIR/t07-4-volume_dir"
}

@test "t07-4b: push new version for session continue test" {
    # Load state from previous test
    VOLUME_DIR=$(cat "$BATS_FILE_TMPDIR/t07-4-volume_dir")

    # Push new volume version
    echo "# Pushing new volume version..."
    cd "$VOLUME_DIR"
    echo "new-volume-content" > data.txt
    run $CLI_COMMAND volume push
    assert_success
    NEW_VERSION=$(echo "$output" | grep -oP 'Version: \K[0-9a-f]+')
    echo "# New version ID: $NEW_VERSION"
    [ -n "$NEW_VERSION" ]
}

@test "t07-4c: continue session with --volume-version override" {
    # Load state from previous tests
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/t07-4-session_id")
    VOLUME_ALIAS=$(cat "$BATS_FILE_TMPDIR/t07-4-volume_alias")
    INITIAL_VERSION=$(cat "$BATS_FILE_TMPDIR/t07-4-initial_version")

    # Continue session with initial volume version override (~15s)
    # Note: --volume-version uses the volume ALIAS from config (test-volume), not the storage name
    echo "# Continuing session with --volume-version override..."
    run $CLI_COMMAND run continue "$SESSION_ID" \
        --volume-version "$VOLUME_ALIAS=$INITIAL_VERSION" \
        "cat /home/user/data/data.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see initial version content (the overridden version)
    assert_output --partial "initial-volume-content"

    # Should NOT see new/latest version content
    refute_output --partial "new-volume-content"

    echo "# Verified: --volume-version correctly overrode volume in session continue"
}
