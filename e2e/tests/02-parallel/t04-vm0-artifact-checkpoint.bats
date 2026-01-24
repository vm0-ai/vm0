#!/usr/bin/env bats

# Test VM0 artifact checkpoint versioning
# This test verifies that:
# 1. Agent runs create new artifact versions during checkpoint
# 2. Resume from checkpoint restores the specific version from checkpoint, not HEAD
#
# Refactored to split multi-vm0-run test into separate cases for timeout safety.
# Each case has max one vm0 run call (~15s), fitting within 30s timeout.
# State is shared between cases via $BATS_FILE_TMPDIR.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file - must be generated in setup_file()
    # and exported to persist across test cases
    export AGENT_NAME="e2e-t04-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t04-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null

    # Create inline config with unique agent name
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for checkpoint testing"
    framework: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    $CLI_COMMAND compose "$TEST_CONFIG" >/dev/null
}

setup() {
    # Per-test setup: create unique artifact name
    export ARTIFACT_NAME="e2e-checkpoint-art-$(date +%s%3N)-$RANDOM"
    export TEST_ARTIFACT_DIR="$TEST_DIR/artifacts"
    mkdir -p "$TEST_ARTIFACT_DIR"
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t04-1: build agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t04-2: create artifact and run agent to create checkpoint" {
    # Step 1: Create artifact with initial content
    echo "# Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    # Initial content: counter at 100, no agent marker
    echo "100" > counter.txt
    echo "initial content" > state.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to create checkpoint (~15s)
    # Agent will: create agent-marker.txt, modify counter.txt from 100 to 101
    echo "# Running agent to modify artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'created by agent' > agent-marker.txt && echo 101 > counter.txt"

    assert_success

    # Verify mock-claude execution events
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "echo 'created by agent'"
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"

    # Extract and save checkpoint ID for next test
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Save state for subsequent tests
    echo "$CHECKPOINT_ID" > "$BATS_FILE_TMPDIR/checkpoint_id"
    echo "$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/artifact_name"
    echo "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/artifact_dir"
}

@test "t04-3: push new content to make HEAD different from checkpoint" {
    # Load state from previous test
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/artifact_name")
    ARTIFACT_DIR=$(cat "$BATS_FILE_TMPDIR/artifact_dir")

    # Push new content to artifact (simulating external changes)
    # This makes HEAD different from the checkpoint version
    echo "# Pushing new content to make HEAD different..."
    cd "$ARTIFACT_DIR"
    echo "0" > counter.txt               # Reset counter to 0
    echo "external content" > state.txt  # Change state
    echo "external marker" > external-marker.txt  # Add new file
    rm -f agent-marker.txt 2>/dev/null || true    # Remove agent's file

    run $CLI_COMMAND artifact push
    assert_success
    echo "# New HEAD version pushed"
}

@test "t04-4: resume from checkpoint restores checkpoint version not HEAD" {
    # Load state from previous tests
    CHECKPOINT_ID=$(cat "$BATS_FILE_TMPDIR/checkpoint_id")

    # Resume from checkpoint - should get checkpoint version, not HEAD (~15s)
    echo "# Resuming from checkpoint: $CHECKPOINT_ID"
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "ls && cat counter.txt"

    assert_success

    # Verify mock-claude execution events for resume
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "ls && cat counter.txt"

    # Verify checkpoint version is restored:
    # Should see agent-marker.txt (created during agent run)
    assert_output --partial "agent-marker.txt"

    # Should NOT see external-marker.txt (added after checkpoint)
    refute_output --partial "external-marker.txt"

    # Counter should be 101 (from checkpoint), not 0 (HEAD)
    assert_output --partial "101"

    # Verify we did NOT get HEAD version content
    refute_output --regexp "^0$"
}
