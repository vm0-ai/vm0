#!/usr/bin/env bats

# Test Runner artifact checkpoint versioning
# The runner is started by the CI workflow before these tests run.
#
# This test verifies that:
# 1. Agent runs create new artifact versions during checkpoint
# 2. Resume from checkpoint restores the specific version from checkpoint, not HEAD
#
# BLACK BOX test - only interacts via CLI/API

load '../../helpers/setup.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t03"

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-runner-checkpoint-art-${UNIQUE_ID}"

    # Create inline config with runner
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for checkpoint testing with runner"
    provider: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
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

@test "Runner checkpoint: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner checkpoint: agent changes preserved on resume, not HEAD" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Compose the agent
    echo "# Step 0: Composing agent..."
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "100" > counter.txt
    echo "initial content" > state.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to modify artifact
    echo "# Step 2: Running agent to modify artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'created by agent' > agent-marker.txt && echo 101 > counter.txt"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        return 1
    }

    # Step 3: Push new content to artifact (simulating external changes)
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "0" > counter.txt
    echo "external content" > state.txt
    echo "external marker" > external-marker.txt
    rm -f agent-marker.txt 2>/dev/null || true

    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Resume from checkpoint
    echo "# Step 4: Resuming from checkpoint..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "ls && cat counter.txt"

    echo "# Resume output:"
    echo "$output"

    assert_success

    # Step 5: Verify checkpoint version is restored
    echo "# Step 5: Verifying checkpoint version..."

    # Should see agent-marker.txt (created during agent run)
    assert_output --partial "agent-marker.txt"

    # Should NOT see external-marker.txt (added after checkpoint)
    refute_output --partial "external-marker.txt"

    # Counter should be 101 (from checkpoint), not 0 (HEAD)
    assert_output --partial "101"
}
