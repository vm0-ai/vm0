#!/usr/bin/env bats

# Test VM0 artifact checkpoint versioning
# This test verifies that:
# 1. Agent runs create new artifact versions during checkpoint
# 2. Resume from checkpoint restores the specific version from checkpoint, not HEAD
#
# Test count: 2 tests with 2 vm0 run calls (1 run + 1 resume)

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t04"

setup() {
    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-checkpoint-art-$(date +%s%3N)-$RANDOM"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for checkpoint testing"
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
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    # Clean up config file
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
}

@test "Build VM0 artifact checkpoint test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 artifact checkpoint: agent changes preserved on resume, not HEAD" {
    # This single test verifies both:
    # 1. Agent run creates new version during checkpoint
    # 2. Resume restores checkpoint version (not HEAD)
    # Optimized from 2 separate tests (4 vm0 runs) to 1 test (2 vm0 runs)

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    # Initial content: counter at 100, no agent marker
    echo "100" > counter.txt
    echo "initial content" > state.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to:
    # - Create agent-marker.txt (new file)
    # - Modify counter.txt from 100 to 101
    echo "# Step 2: Running agent to modify artifact..."
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'created by agent' > agent-marker.txt && echo 101 > counter.txt"

    assert_success

    # Verify mock-claude execution events (deterministic with mock-claude)
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "echo 'created by agent'"
    assert_output --partial "[result]"

    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Step 3: Push new content to artifact (simulating external changes)
    # This makes HEAD different from the checkpoint version
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "0" > counter.txt               # Reset counter to 0
    echo "external content" > state.txt  # Change state
    echo "external marker" > external-marker.txt  # Add new file
    rm -f agent-marker.txt 2>/dev/null || true    # Remove agent's file

    run $CLI_COMMAND artifact push
    assert_success
    echo "# New HEAD version pushed"

    # Step 4: Resume from checkpoint - should get checkpoint version, not HEAD
    # Use 120s timeout as resume involves S3 download + sandbox startup + session restore
    echo "# Step 4: Resuming from checkpoint..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "ls && cat counter.txt"

    assert_success

    # Verify mock-claude execution events for resume
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "ls && cat counter.txt"

    # Step 5: Verify checkpoint version is restored
    echo "# Step 5: Verifying checkpoint version is restored..."

    # Should see agent-marker.txt (created during agent run)
    # With mock-claude, ls output is deterministic
    assert_output --partial "agent-marker.txt"

    # Should NOT see external-marker.txt (added after checkpoint)
    refute_output --partial "external-marker.txt"

    # Counter should be 101 (from checkpoint), not 0 (HEAD)
    # With mock-claude, cat output is deterministic
    assert_output --partial "101"

    # Verify we did NOT get HEAD version content
    refute_output --regexp "^0$"
}
