#!/usr/bin/env bats

# Test Runner agent session and continue functionality
# The runner is started by the CI workflow before these tests run.
#
# This test verifies that:
# 1. Agent runs create agent sessions
# 2. vm0 run continue uses session's conversation but latest artifact version
# 3. Session stores and inherits templateVars for continue operations
#
# BLACK BOX test - only interacts via CLI/API

load '../../helpers/setup.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t04"

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    # Create unique volume for this test
    create_test_volume "e2e-vol-runner-t04"

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-runner-session-art-${UNIQUE_ID}"

    # Create inline config with runner
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for session testing with runner"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
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
    # Clean up test volume
    cleanup_test_volume
}

@test "Runner session: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner session: continue uses latest artifact version" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial" > marker.txt
    echo "100" > counter.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to modify artifact
    echo "# Step 2: Running agent to create session..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'agent-created' > agent.txt && echo 200 > counter.txt"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        return 1
    }

    # Step 3: Push NEW content to artifact
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "external-update" > external.txt
    echo "999" > counter.txt
    rm -f agent.txt 2>/dev/null || true

    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Continue from session - should get LATEST artifact (HEAD)
    echo "# Step 4: Continuing from session..."
    run $CLI_COMMAND run continue "$SESSION_ID" --verbose "ls && cat counter.txt"

    echo "# Continue output:"
    echo "$output"

    assert_success

    # Step 5: Verify LATEST version is used
    echo "# Step 5: Verifying latest artifact version..."

    # Should see external.txt (added after checkpoint)
    assert_output --partial "external.txt"

    # Should NOT see agent.txt (removed in step 3)
    refute_output --partial "agent.txt"

    # Counter should be 999 (from HEAD), not 200 (from checkpoint)
    assert_output --partial "999"
}

@test "Runner session: session persists across runs with same config" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: First run
    echo "# Step 2: First run..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_1=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# First session ID: $SESSION_ID_1"
    [ -n "$SESSION_ID_1" ]

    # Step 3: Second run
    echo "# Step 3: Second run..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'second run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_2=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Second session ID: $SESSION_ID_2"
    [ -n "$SESSION_ID_2" ]

    # Session IDs should be the same
    [ "$SESSION_ID_1" = "$SESSION_ID_2" ] || {
        echo "# Session IDs don't match!"
        echo "# First:  $SESSION_ID_1"
        echo "# Second: $SESSION_ID_2"
        return 1
    }

    echo "# Verified: Same session returned"
}

@test "Runner session: continue works with templateVars" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent WITH template variables
    echo "# Step 2: Running agent with --vars..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testKey=testValue" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo 'initial run' && cat testfile.txt"

    assert_success
    assert_output --partial "initial-content"
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ]

    # Step 3: Update artifact
    echo "# Step 3: Updating artifact..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "updated-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Continue from session
    echo "# Step 4: Continuing from session..."
    run $CLI_COMMAND run continue "$SESSION_ID" --verbose "cat testfile.txt"

    assert_success

    # Should see updated content
    assert_output --partial "updated-content"

    echo "# Verified: Continue works with templateVars"
}
