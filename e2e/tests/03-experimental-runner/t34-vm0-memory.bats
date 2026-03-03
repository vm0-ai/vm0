#!/usr/bin/env bats

# Test VM0 memory flag persistence across continue and resume flows
# This test verifies that:
# 1. Agent runs with --memory flag can write files to the memory mount path
# 2. vm0 run continue restores memory (files persist without --memory flag)
# 3. vm0 run resume restores memory from checkpoint (files persist without --memory flag)
#
# mock-claude executes the prompt as a bash command, so we write a marker file
# into /home/user/.vm0/memory and verify it survives across continue/resume.
#
# Each case has max one vm0 run call (~15s), fitting within 30s timeout.
# State is shared between cases via $BATS_FILE_TMPDIR.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t34-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t34-$(date +%s%3N)-$RANDOM"
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
    description: "E2E test agent for memory flag testing"
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

    # Generate unique memory name for this test file
    export MEMORY_NAME="e2e-mem-t34-$(date +%s%3N)-$RANDOM"
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t34-1: build agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t34-2: run agent with --memory flag and write marker file" {
    echo "# Running agent with --memory $MEMORY_NAME..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --memory "$MEMORY_NAME" \
        "mkdir -p /home/user/.vm0/memory && echo 'memory-marker-t34' > /home/user/.vm0/memory/marker.txt && cat /home/user/.vm0/memory/marker.txt"

    assert_success

    # Verify mock-claude execution events
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract and save checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Extract and save session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Save state for subsequent tests
    echo "$CHECKPOINT_ID" > "$BATS_FILE_TMPDIR/checkpoint_id"
    echo "$SESSION_ID" > "$BATS_FILE_TMPDIR/session_id"
}

@test "t34-3: continue from session reads marker file from memory" {
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/session_id")

    echo "# Continuing from session: $SESSION_ID (no --memory flag)..."
    run $CLI_COMMAND run continue "$SESSION_ID" \
        --verbose \
        "cat /home/user/.vm0/memory/marker.txt"

    assert_success

    # Verify execution happened and marker file content is readable
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
}

@test "t34-4: resume from checkpoint reads marker file from memory" {
    CHECKPOINT_ID=$(cat "$BATS_FILE_TMPDIR/checkpoint_id")

    echo "# Resuming from checkpoint: $CHECKPOINT_ID (no --memory flag)..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        --verbose \
        "cat /home/user/.vm0/memory/marker.txt"

    assert_success

    # Verify execution happened and marker file content is readable
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
}
