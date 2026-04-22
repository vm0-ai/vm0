#!/usr/bin/env bats

# Test VM0 artifact checkpoint versioning
# This test verifies that:
# 1. Agent runs create new artifact versions during checkpoint
# 2. Resume from checkpoint restores the specific version from checkpoint, not HEAD
#
# All tests are independent and parallelizable.
# t04-1 validates compose config.
# t04-2 runs the full checkpoint versioning workflow in a single test.

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
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create inline config with unique agent name
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for checkpoint testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
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
    run $VM0_CLI compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t04-2: resume from checkpoint restores checkpoint version not HEAD" {
    # --- Phase 1: Create artifact with initial content ---
    local artifact_name="$ARTIFACT_NAME"
    local artifact_dir="$TEST_ARTIFACT_DIR/$artifact_name"

    echo "# Creating initial artifact..."
    mkdir -p "$artifact_dir"
    cd "$artifact_dir"
    $VM0_CLI artifact init --name "$artifact_name" >/dev/null

    # Initial content: counter at 100, no agent marker
    echo "100" > counter.txt
    echo "initial content" > state.txt
    run $VM0_CLI artifact push
    assert_success

    # --- Phase 2: Run agent to create checkpoint (~15s) ---
    # Agent will: create agent-marker.txt, modify counter.txt from 100 to 101
    echo "# Running agent to modify artifact..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$artifact_name:/home/user/workspace" \
        "echo 'created by agent' > agent-marker.txt && echo 101 > counter.txt"

    assert_success

    # Verify mock-claude execution events
    assert_output --partial "● Bash("
    assert_output --partial "echo 'created by agent'"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID as a local variable
    local checkpoint_id
    checkpoint_id=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $checkpoint_id"
    [ -n "$checkpoint_id" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # --- Phase 3: Push new content to make HEAD different from checkpoint ---
    # This makes HEAD different from the checkpoint version
    echo "# Pushing new content to make HEAD different..."
    cd "$artifact_dir"
    echo "0" > counter.txt               # Reset counter to 0
    echo "external content" > state.txt  # Change state
    echo "external marker" > external-marker.txt  # Add new file
    rm -f agent-marker.txt 2>/dev/null || true    # Remove agent's file

    run $VM0_CLI artifact push
    assert_success
    echo "# New HEAD version pushed"

    # --- Phase 4: Resume from checkpoint and verify ---
    # Should get checkpoint version, not HEAD (~15s)
    echo "# Resuming from checkpoint: $checkpoint_id"
    run $VM0_CLI run resume "$checkpoint_id" \
        --verbose \
        "ls && cat counter.txt"

    assert_success

    # Verify mock-claude execution events for resume
    assert_output --partial "● Bash("
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
