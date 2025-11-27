#!/usr/bin/env bats

# Test VM0 agent session and continue functionality
# This test verifies that:
# 1. Agent runs create agent sessions
# 2. vm0 run continue uses session's conversation but latest artifact version
# 3. Session stores and inherits templateVars for continue operations
#
# Test count: 4 tests with 6 vm0 run calls

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-session-art-$(date +%s)"
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-standard.yaml"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "Build VM0 agent session test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-standard"
}

@test "VM0 agent session: continue uses latest artifact version" {
    # This test verifies:
    # 1. Agent run creates an agent session
    # 2. Continue from session uses latest artifact (not checkpoint snapshot)

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    echo "initial" > marker.txt
    echo "100" > counter.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to modify artifact
    echo "# Step 2: Running agent to create session..."
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'agent-created' > agent.txt && echo 200 > counter.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "[result]"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Step 3: Push NEW content to artifact (simulating external changes)
    # This makes HEAD different from the checkpoint version
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "external-update" > external.txt   # Add new file
    echo "999" > counter.txt                 # Update counter
    rm -f agent.txt 2>/dev/null || true      # Remove agent's file

    run $CLI_COMMAND artifact push
    assert_success
    echo "# New HEAD version pushed"

    # Step 4: Continue from session - should get LATEST artifact (HEAD), not checkpoint
    # This is the KEY DIFFERENCE from checkpoint resume
    echo "# Step 4: Continuing from session (should use latest artifact)..."
    run $CLI_COMMAND run continue --timeout 120 "$SESSION_ID" "ls && cat counter.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "[tool_result]"

    # Step 5: Verify LATEST version is used (not checkpoint version)
    echo "# Step 5: Verifying latest artifact version is used..."

    # Should see external.txt (added after checkpoint in step 3)
    assert_output --partial "external.txt"

    # Should NOT see agent.txt (it was removed in step 3)
    refute_output --partial "agent.txt"

    # Counter should be 999 (from HEAD/latest), not 200 (from checkpoint)
    assert_output --partial "999"

    # Verify we did NOT get checkpoint version content
    refute_output --regexp "^200$"
}

@test "VM0 agent session: session persists across runs with same config and artifact" {
    # This test verifies that findOrCreate returns existing session

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    echo "test" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: First run - creates new session
    echo "# Step 2: First run (creates session)..."
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_1=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# First session ID: $SESSION_ID_1"
    [ -n "$SESSION_ID_1" ]

    # Step 3: Second run with same config and artifact - should return same session
    echo "# Step 3: Second run (should return same session)..."
    run $CLI_COMMAND run vm0-standard \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'second run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_2=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Second session ID: $SESSION_ID_2"
    [ -n "$SESSION_ID_2" ]

    # Session IDs should be the same (findOrCreate returns existing)
    [ "$SESSION_ID_1" = "$SESSION_ID_2" ] || {
        echo "# Session IDs don't match!"
        echo "# First:  $SESSION_ID_1"
        echo "# Second: $SESSION_ID_2"
        return 1
    }

    echo "# Verified: Same session returned for subsequent runs"
}

@test "VM0 agent session: continue works with templateVars" {
    # This test verifies that continue works correctly when the original run
    # had template variables set via -e flag. The templateVars are stored in
    # the session and should be inherited when continuing.
    #
    # Note: We use vm0-standard (without template vars in config) to test the
    # basic templateVars storage and retrieval mechanism. The actual template
    # expansion in volumes is tested separately.

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null

    echo "initial-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent WITH template variables (even though config doesn't use them)
    # This tests that templateVars are properly stored in the session
    echo "# Step 2: Running agent with --vars testKey=testValue..."
    run $CLI_COMMAND run vm0-standard \
        --vars "testKey=testValue" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'initial run' && cat testfile.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "initial-content"
    assert_output --partial "Session:"

    # Extract session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Step 3: Update artifact with new content
    echo "# Step 3: Updating artifact..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "updated-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Continue from session
    # This verifies that:
    # 1. The continue API correctly retrieves templateVars from the session
    # 2. The continue works even when original run had templateVars
    echo "# Step 4: Continuing from session..."
    run $CLI_COMMAND run continue --timeout 120 "$SESSION_ID" "cat testfile.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see updated content (latest artifact version)
    assert_output --partial "updated-content"

    echo "# Verified: Continue works with templateVars stored in session"
}
