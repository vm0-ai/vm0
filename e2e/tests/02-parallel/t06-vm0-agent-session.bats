#!/usr/bin/env bats

# Test VM0 agent session and continue functionality
# This test verifies that:
# 1. Agent runs create agent sessions
# 2. vm0 run continue uses session's conversation but latest artifact version
# 3. Session stores and inherits templateVars for continue operations
#
# Refactored to split multi-vm0-run tests into separate cases for timeout safety.
# Each case has max one vm0 run call (~15s), fitting within 30s timeout.
# State is shared between cases via $BATS_FILE_TMPDIR.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file - must be generated in setup_file()
    # and exported to persist across test cases
    export AGENT_NAME="e2e-t06-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t06-$(date +%s%3N)-$RANDOM"
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

    # Compose agent once for all tests in this file
    $CLI_COMMAND compose "$TEST_CONFIG" >/dev/null
}

setup() {
    # Per-test setup: create unique artifact name
    export ARTIFACT_NAME="e2e-session-art-$(date +%s%3N)-$RANDOM"
    export TEST_ARTIFACT_DIR="$TEST_DIR/artifacts"
    mkdir -p "$TEST_ARTIFACT_DIR"
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# =============================================================================
# Test 1: Build configuration (fast, no vm0 run)
# =============================================================================

@test "t06-1: build agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

# =============================================================================
# Test 2: Continue uses latest artifact version
# Split into 4 cases: create artifact, run agent, push new content, continue
# =============================================================================

@test "t06-2a: create artifact for continue-latest test" {
    echo "# Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial" > marker.txt
    echo "100" > counter.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Save artifact info for subsequent tests
    echo "$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-2-artifact_name"
    echo "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-2-artifact_dir"
}

@test "t06-2b: run agent to create session" {
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-2-artifact_name")

    echo "# Running agent to create session..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'agent-created' > agent.txt && echo 200 > counter.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract and save session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    echo "$SESSION_ID" > "$BATS_FILE_TMPDIR/t06-2-session_id"
}

@test "t06-2c: push new content to make HEAD different" {
    ARTIFACT_DIR=$(cat "$BATS_FILE_TMPDIR/t06-2-artifact_dir")

    echo "# Pushing new content to make HEAD different..."
    cd "$ARTIFACT_DIR"
    echo "external-update" > external.txt   # Add new file
    echo "999" > counter.txt                 # Update counter
    rm -f agent.txt 2>/dev/null || true      # Remove agent's file

    run $CLI_COMMAND artifact push
    assert_success
    echo "# New HEAD version pushed"
}

@test "t06-2d: continue session uses latest artifact version" {
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/t06-2-session_id")

    echo "# Continuing from session (should use latest artifact)..."
    run $CLI_COMMAND run continue "$SESSION_ID" --verbose "ls && cat counter.txt"

    assert_success
    assert_output --partial "● Bash("

    # Verify LATEST version is used (not checkpoint version)
    # Should see external.txt (added after checkpoint)
    assert_output --partial "external.txt"

    # Should NOT see agent.txt (it was removed)
    refute_output --partial "agent.txt"

    # Counter should be 999 (from HEAD/latest), not 200 (from checkpoint)
    assert_output --partial "999"
    refute_output --regexp "^200$"
}

# =============================================================================
# Test 3: Session persists across runs with same config and artifact
# Split into 3 cases: create artifact, first run, second run + verify
# =============================================================================

@test "t06-3a: create artifact for session-persists test" {
    echo "# Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    echo "$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-3-artifact_name"
}

@test "t06-3b: first run creates new session" {
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-3-artifact_name")

    echo "# First run (creates session)..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_1=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# First session ID: $SESSION_ID_1"
    [ -n "$SESSION_ID_1" ]

    echo "$SESSION_ID_1" > "$BATS_FILE_TMPDIR/t06-3-session_id_1"
}

@test "t06-3c: second run returns same session" {
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-3-artifact_name")
    SESSION_ID_1=$(cat "$BATS_FILE_TMPDIR/t06-3-session_id_1")

    echo "# Second run (should return same session)..."
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

# =============================================================================
# Test 4: Continue works with templateVars
# Split into 3 cases: create artifact, run with vars, continue
# =============================================================================

@test "t06-4a: create artifact for templateVars test" {
    echo "# Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    echo "$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-4-artifact_name"
    echo "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-4-artifact_dir"
}

@test "t06-4b: run agent with templateVars" {
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-4-artifact_name")

    echo "# Running agent with --vars testKey=testValue..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testKey=testValue" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo 'initial run' && cat testfile.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "initial-content"
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    echo "$SESSION_ID" > "$BATS_FILE_TMPDIR/t06-4-session_id"
}

@test "t06-4c: update artifact content" {
    ARTIFACT_DIR=$(cat "$BATS_FILE_TMPDIR/t06-4-artifact_dir")

    echo "# Updating artifact..."
    cd "$ARTIFACT_DIR"
    echo "updated-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success
}

@test "t06-4d: continue from session with templateVars" {
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/t06-4-session_id")

    echo "# Continuing from session..."
    run $CLI_COMMAND run continue "$SESSION_ID" --verbose "cat testfile.txt"

    assert_success
    assert_output --partial "● Bash("

    # Should see updated content (latest artifact version)
    assert_output --partial "updated-content"

    echo "# Verified: Continue works with templateVars stored in session"
}

# =============================================================================
# Test 5: Run continue loads secrets from environment variables
# Split into 3 cases: setup config, run with secrets, continue with env
# =============================================================================

@test "t06-5a: setup config with secrets for continue test" {
    # Create env-expansion config dynamically with unique agent name
    local ENV_AGENT_NAME="e2e-env-continue-$(date +%s%3N)-$RANDOM"
    local ENV_CONFIG="$TEST_DIR/env-continue.yaml"
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

    echo "# Building config with secrets..."
    run $CLI_COMMAND compose "$ENV_CONFIG"
    assert_success
    assert_output --partial "$ENV_AGENT_NAME"

    # Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    echo "$ENV_AGENT_NAME" > "$BATS_FILE_TMPDIR/t06-5-env_agent_name"
    echo "$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-5-artifact_name"
}

@test "t06-5b: run agent with secrets to create session" {
    ENV_AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-5-env_agent_name")
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-5-artifact_name")

    echo "# Running agent with secrets to create session..."
    run $CLI_COMMAND run "$ENV_AGENT_NAME" \
        --vars "testVar=myTestVar" \
        --secrets "TEST_SECRET=initial-secret-value" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'test' && echo \$TEST_SECRET"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    echo "$SESSION_ID" > "$BATS_FILE_TMPDIR/t06-5-session_id"
}

@test "t06-5c: continue loads secrets from environment variables" {
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/t06-5-session_id")

    echo "# Continuing with secret in environment variable..."
    export TEST_SECRET="env-secret-value"
    run $CLI_COMMAND run continue "$SESSION_ID" "echo 'continue test'"

    # Should succeed - the secret was loaded from environment variable
    assert_success
    assert_output --partial "● Bash("

    # Verify the run completed successfully (not failed due to missing secrets)
    refute_output --partial "Missing required secrets"

    echo "# Verified: run continue loads secrets from environment variables"
}

# =============================================================================
# Test 6: Run resume loads secrets from environment variables
# Split into 3 cases: setup config, run with secrets, resume with env
# =============================================================================

@test "t06-6a: setup config with secrets for resume test" {
    # Create env-expansion config dynamically with unique agent name
    local ENV_AGENT_NAME="e2e-env-resume-$(date +%s%3N)-$RANDOM"
    local ENV_CONFIG="$TEST_DIR/env-resume.yaml"
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

    echo "# Building config with secrets..."
    run $CLI_COMMAND compose "$ENV_CONFIG"
    assert_success

    # Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    echo "$ENV_AGENT_NAME" > "$BATS_FILE_TMPDIR/t06-6-env_agent_name"
    echo "$ARTIFACT_NAME" > "$BATS_FILE_TMPDIR/t06-6-artifact_name"
}

@test "t06-6b: run agent with secrets to create checkpoint" {
    ENV_AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-6-env_agent_name")
    ARTIFACT_NAME=$(cat "$BATS_FILE_TMPDIR/t06-6-artifact_name")

    echo "# Running agent with secrets to create checkpoint..."
    run $CLI_COMMAND run "$ENV_AGENT_NAME" \
        --vars "testVar=myTestVar" \
        --secrets "TEST_SECRET=initial-secret-value" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'test'"

    assert_success
    assert_output --partial "Checkpoint:"

    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    echo "$CHECKPOINT_ID" > "$BATS_FILE_TMPDIR/t06-6-checkpoint_id"
}

@test "t06-6c: resume loads secrets from environment variables" {
    CHECKPOINT_ID=$(cat "$BATS_FILE_TMPDIR/t06-6-checkpoint_id")

    echo "# Resuming with secret in environment variable..."
    export TEST_SECRET="env-secret-value"
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" "echo 'resume test'"

    # Should succeed - the secret was loaded from environment variable
    assert_success
    assert_output --partial "● Bash("

    # Verify the run completed successfully (not failed due to missing secrets)
    refute_output --partial "Missing required secrets"

    echo "# Verified: run resume loads secrets from environment variables"
}
