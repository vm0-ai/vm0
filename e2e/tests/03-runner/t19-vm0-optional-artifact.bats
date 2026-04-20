#!/usr/bin/env bats

# Test VM0 optional artifact functionality
# This test verifies that:
# 1. Agent runs work without --artifact flag
# 2. Each run without artifact creates its own session (multi-session)
# 3. Checkpoints are created even without artifact
# 4. Continue works from session without artifact
#
# Test count: 4 tests

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-t19-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume and compose ONCE so parallel tests don't race
    create_test_volume "e2e-vol-t19"
    export SHARED_VOLUME_NAME="$VOLUME_NAME"
    export SHARED_VOLUME_DIR="$TEST_VOLUME_DIR"

    export SHARED_CONFIG="$TEST_DIR/vm0.yaml"
    cat > "$SHARED_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for optional artifact testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $SHARED_VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$SHARED_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    if [ -n "$SHARED_VOLUME_DIR" ] && [ -d "$SHARED_VOLUME_DIR" ]; then
        rm -rf "$SHARED_VOLUME_DIR"
    fi
}

@test "Build VM0 optional artifact test agent configuration" {
    run $VM0_CLI compose "$SHARED_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 run without artifact: basic run succeeds" {
    # This test verifies that vm0 run works without --artifact
    # The agent should run, execute tasks, and complete successfully

    echo "# Running agent without artifact..."
    run $VM0_CLI run "$AGENT_NAME" --verbose "echo 'hello world' && pwd"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "hello world"
    assert_output --partial "◆ Claude Code Completed"

    # Should still report session and checkpoint
    assert_output --partial "Session:"
    assert_output --partial "Checkpoint:"
}

@test "VM0 run without artifact: each run creates its own session" {
    # This test verifies that each independent run without artifact
    # creates a new session (supporting multiple chat sessions per agent).
    # To reuse a session, use "vm0 run continue <sessionId>".

    # Step 1: First run without artifact - creates new session
    echo "# Step 1: First run without artifact..."
    run $VM0_CLI run "$AGENT_NAME" "echo 'first run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_1=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# First session ID: $SESSION_ID_1"
    [ -n "$SESSION_ID_1" ] || {
        echo "# Failed to extract session ID from first run"
        echo "$output"
        return 1
    }

    # Step 2: Second run without artifact with same config
    # Each run creates its own session (multi-session support)
    echo "# Step 2: Second run without artifact..."
    run $VM0_CLI run "$AGENT_NAME" "echo 'second run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_2=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Second session ID: $SESSION_ID_2"
    [ -n "$SESSION_ID_2" ] || {
        echo "# Failed to extract session ID from second run"
        echo "$output"
        return 1
    }

    # Session IDs should be different (each run gets its own session)
    [ "$SESSION_ID_1" != "$SESSION_ID_2" ] || {
        echo "# Session IDs should differ but are the same!"
        echo "# First:  $SESSION_ID_1"
        echo "# Second: $SESSION_ID_2"
        return 1
    }

    echo "# Verified: Each run without artifact creates its own session"
}

@test "VM0 run without artifact: continue from session works" {
    # This test verifies that continue works from a session
    # created without artifact

    # Step 1: Initial run without artifact
    echo "# Step 1: Initial run without artifact..."
    run $VM0_CLI run "$AGENT_NAME" "echo 'initial context'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Step 2: Continue from session
    echo "# Step 2: Continuing from session..."
    run $VM0_CLI run continue "$SESSION_ID" --verbose "echo 'continued from session'"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "continued from session"

    echo "# Verified: Continue works from session without artifact"
}
