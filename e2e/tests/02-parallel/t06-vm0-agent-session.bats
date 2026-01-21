#!/usr/bin/env bats

# Test VM0 agent session and continue functionality
# This test verifies that:
# 1. Agent runs create agent sessions
# 2. vm0 run continue uses session's conversation but latest artifact version
# 3. Session stores and inherits templateVars for continue operations
#
# Test count: 4 tests with 6 vm0 run calls

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t06"

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-t06"

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-session-art-$(date +%s%3N)-$RANDOM"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for session testing"
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

@test "Build VM0 agent session test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 agent session: continue uses latest artifact version" {
    # This test verifies:
    # 1. Agent run creates an agent session
    # 2. Continue from session uses latest artifact (not checkpoint snapshot)

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
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
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
    run $CLI_COMMAND run continue "$SESSION_ID" "ls && cat counter.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

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
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: First run - creates new session
    echo "# Step 2: First run (creates session)..."
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_1=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# First session ID: $SESSION_ID_1"
    [ -n "$SESSION_ID_1" ]

    # Step 3: Second run with same config and artifact - should return same session
    echo "# Step 3: Second run (should return same session)..."
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
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
    # Note: We use this agent (without template vars in config) to test the
    # basic templateVars storage and retrieval mechanism. The actual template
    # expansion in volumes is tested separately.

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent WITH template variables (even though config doesn't use them)
    # This tests that templateVars are properly stored in the session
    echo "# Step 2: Running agent with --vars testKey=testValue..."
    # Use extended timeout for CI environments which may be slower
    run $CLI_COMMAND run "$AGENT_NAME" \
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
    run $CLI_COMMAND run continue "$SESSION_ID" "cat testfile.txt"

    assert_success
    assert_output --partial "[tool_use] Bash"

    # Should see updated content (latest artifact version)
    assert_output --partial "updated-content"

    echo "# Verified: Continue works with templateVars stored in session"
}

@test "VM0 agent session: run continue loads secrets from environment variables" {
    # This test verifies that vm0 run continue automatically loads secrets
    # from environment variables when not provided via --secrets flag.
    # This is the fix for issue #845.

    # Create env-expansion config dynamically with unique agent name
    local ENV_AGENT_NAME="e2e-env-continue-$(date +%s%3N)-$RANDOM"
    local ENV_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$ENV_CONFIG" <<EOF
version: "1.0"
agents:
  ${ENV_AGENT_NAME}:
    description: "Test agent for environment variable expansion"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      TEST_VAR: "\${{ vars.testVar }}"
      TEST_SECRET: "\${{ secrets.TEST_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Step 1: Build the config with secrets
    echo "# Step 1: Building config with secrets..."
    run $CLI_COMMAND compose "$ENV_CONFIG"
    assert_success
    assert_output --partial "$ENV_AGENT_NAME"

    # Step 2: Create artifact
    echo "# Step 2: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 3: Run agent WITH secrets to create session
    # The env-expansion config has: TEST_VAR and TEST_SECRET
    echo "# Step 3: Running agent with secrets to create session..."
    run $CLI_COMMAND run "$ENV_AGENT_NAME" \
        --vars "testVar=myTestVar" \
        --secrets "TEST_SECRET=initial-secret-value" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'test' && echo \$TEST_SECRET"

    assert_success
    assert_output --partial "Session:"

    # Extract session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Clean up config file
    rm -f "$ENV_CONFIG"

    # Step 4: Continue WITHOUT --secrets flag, but WITH env var set
    # This is the key test: secrets should be loaded from environment
    echo "# Step 4: Continuing with secret in environment variable..."
    export TEST_SECRET="env-secret-value"
    run $CLI_COMMAND run continue "$SESSION_ID" "echo 'continue test'"

    # Should succeed - the secret was loaded from environment variable
    assert_success
    assert_output --partial "[tool_use] Bash"

    # Verify the run completed successfully (not failed due to missing secrets)
    refute_output --partial "Missing required secrets"

    echo "# Verified: run continue loads secrets from environment variables"
}

@test "VM0 agent session: run resume loads secrets from environment variables" {
    # This test verifies that vm0 run resume automatically loads secrets
    # from environment variables when not provided via --secrets flag.
    # This is the fix for issue #845.

    # Create env-expansion config dynamically with unique agent name
    local ENV_AGENT_NAME="e2e-env-resume-$(date +%s%3N)-$RANDOM"
    local ENV_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$ENV_CONFIG" <<EOF
version: "1.0"
agents:
  ${ENV_AGENT_NAME}:
    description: "Test agent for environment variable expansion"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      TEST_VAR: "\${{ vars.testVar }}"
      TEST_SECRET: "\${{ secrets.TEST_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Step 1: Build the config with secrets
    echo "# Step 1: Building config with secrets..."
    run $CLI_COMMAND compose "$ENV_CONFIG"
    assert_success

    # Step 2: Create artifact
    echo "# Step 2: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 3: Run agent WITH secrets to create checkpoint
    echo "# Step 3: Running agent with secrets to create checkpoint..."
    run $CLI_COMMAND run "$ENV_AGENT_NAME" \
        --vars "testVar=myTestVar" \
        --secrets "TEST_SECRET=initial-secret-value" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'test'"

    assert_success
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Clean up config file
    rm -f "$ENV_CONFIG"

    # Step 4: Resume WITHOUT --secrets flag, but WITH env var set
    # This is the key test: secrets should be loaded from environment
    echo "# Step 4: Resuming with secret in environment variable..."
    export TEST_SECRET="env-secret-value"
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" "echo 'resume test'"

    # Should succeed - the secret was loaded from environment variable
    assert_success
    assert_output --partial "[tool_use] Bash"

    # Verify the run completed successfully (not failed due to missing secrets)
    refute_output --partial "Missing required secrets"

    echo "# Verified: run resume loads secrets from environment variables"
}
