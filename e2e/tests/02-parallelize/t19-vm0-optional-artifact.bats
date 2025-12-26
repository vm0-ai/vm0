#!/usr/bin/env bats

# Test VM0 optional artifact functionality
# This test verifies that:
# 1. Agent runs work without --artifact-name flag
# 2. Sessions are created even without artifact
# 3. Checkpoints are created even without artifact
# 4. Continue works from session without artifact
#
# Test count: 4 tests

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t19"

setup() {
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for optional artifact testing"
    provider: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: claude-files
    version: latest
EOF
}

teardown() {
    # Clean up config file
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
}

@test "Build VM0 optional artifact test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 run without artifact: basic run succeeds" {
    # This test verifies that vm0 run works without --artifact-name
    # The agent should run, execute tasks, and complete successfully

    echo "# Running agent without artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" "echo 'hello world' && pwd"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "hello world"
    assert_output --partial "[result]"

    # Should still report session and checkpoint
    assert_output --partial "Session:"
    assert_output --partial "Checkpoint:"
}

@test "VM0 run without artifact: session persists across runs" {
    # This test verifies that sessions are created and persisted
    # even when running without artifact

    # Step 1: First run without artifact - creates new session
    echo "# Step 1: First run without artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" "echo 'first run'"

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
    # Should return the same session (findOrCreate behavior)
    echo "# Step 2: Second run without artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" "echo 'second run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_2=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Second session ID: $SESSION_ID_2"
    [ -n "$SESSION_ID_2" ] || {
        echo "# Failed to extract session ID from second run"
        echo "$output"
        return 1
    }

    # Session IDs should be the same (findOrCreate returns existing)
    [ "$SESSION_ID_1" = "$SESSION_ID_2" ] || {
        echo "# Session IDs don't match!"
        echo "# First:  $SESSION_ID_1"
        echo "# Second: $SESSION_ID_2"
        return 1
    }

    echo "# Verified: Same session returned for runs without artifact"
}

@test "VM0 run without artifact: continue from session works" {
    # This test verifies that continue works from a session
    # created without artifact

    # Step 1: Initial run without artifact
    echo "# Step 1: Initial run without artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" "echo 'initial context'"

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
    run $CLI_COMMAND run continue "$SESSION_ID" "echo 'continued from session'"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "continued from session"

    echo "# Verified: Continue works from session without artifact"
}
