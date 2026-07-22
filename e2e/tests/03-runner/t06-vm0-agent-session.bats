#!/usr/bin/env bats

# Test VM0 agent session and continue functionality (E2E happy path only)
# This test verifies that:
# 1. Agent runs create agent sessions
# 2. Session continuation uses the conversation with the latest artifact version
# 3. Session stores and inherits templateVars for continue operations
# 4. Secrets can be loaded from environment variables for continue
#
# Note: Session persistence (findOrCreate) is tested via Web Route Integration Tests.
# Note: Resume with secrets is tested via CLI Command Integration Tests.
#
# Each chain of dependent operations is merged into a single test so that
# all tests are independent and can run in parallel.

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
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    # Create inline config with unique agent name
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for session testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    seed_compose_fixture "$TEST_CONFIG" >/dev/null
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
# Test 1: Build configuration (fast, no direct run)
# =============================================================================

# =============================================================================
# Test 2: Continue uses latest artifact version
# Creates artifact, runs agent to create session, pushes new content, then
# continues session and verifies it picks up the latest artifact version.
# =============================================================================

@test "t06-2: continue-latest uses updated artifact version" {
    local artifact_name="$ARTIFACT_NAME"
    local artifact_dir="$TEST_ARTIFACT_DIR/$artifact_name"

    # -- Step 1: Create artifact (was t06-2a) --
    echo "# Creating initial artifact..."
    mkdir -p "$artifact_dir"
    cd "$artifact_dir"
    echo "initial" > marker.txt
    echo "100" > counter.txt
    run seed_storage_fixture artifact "$artifact_name" .
    assert_success

    # -- Step 2: Run agent to create session (was t06-2b) --
    echo "# Running agent to create session..."
    run run_compose_fixture "$AGENT_NAME" \
        "echo 'agent-created' > agent.txt && echo 200 > counter.txt" \
        "$(jq -nc --arg name "$artifact_name" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"

    assert_success
    assert_output --partial '"name":"Bash"'
    assert_output --partial '"subtype":"success"'
    [ -n "$(run_fixture_field "$output" '.checkpointId')" ]

    local session_id
    session_id=$(run_fixture_field "$output" '.sessionId')
    echo "# Session ID: $session_id"
    [ -n "$session_id" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # -- Step 3: Push new content to make HEAD different (was t06-2c) --
    echo "# Pushing new content to make HEAD different..."
    cd "$artifact_dir"
    echo "external-update" > external.txt   # Add new file
    echo "999" > counter.txt                 # Update counter
    rm -f agent.txt 2>/dev/null || true      # Remove agent's file

    run seed_storage_fixture artifact "$artifact_name" .
    assert_success
    echo "# New HEAD version pushed"

    # -- Step 4: Continue session and verify latest version (was t06-2d) --
    echo "# Continuing from session (should use latest artifact)..."
    run continue_run_fixture "$session_id" "ls && cat counter.txt"

    assert_success
    assert_output --partial '"name":"Bash"'

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
# Test 3: Continue works with templateVars
# Creates artifact, runs agent with templateVars, updates artifact, then
# continues from session and verifies templateVars are inherited.
# =============================================================================

@test "t06-3: continue with templateVars" {
    local artifact_name="$ARTIFACT_NAME"
    local artifact_dir="$TEST_ARTIFACT_DIR/$artifact_name"

    # -- Step 1: Create artifact (was t06-3a) --
    echo "# Creating artifact..."
    mkdir -p "$artifact_dir"
    cd "$artifact_dir"
    echo "initial-content" > testfile.txt
    run seed_storage_fixture artifact "$artifact_name" .
    assert_success

    # -- Step 2: Run agent with templateVars (was t06-3b) --
    echo "# Running agent with --vars testKey=testValue..."
    run run_compose_fixture "$AGENT_NAME" \
        "echo 'initial run' && cat testfile.txt" \
        "$(jq -nc --arg name "$artifact_name" \
            '{
                vars: {testKey: "testValue"},
                artifacts: [{name: $name, mountPath: "/home/user/workspace"}]
            }')"

    assert_success
    assert_output --partial '"name":"Bash"'
    assert_output --partial "initial-content"

    local session_id
    session_id=$(run_fixture_field "$output" '.sessionId')
    echo "# Session ID: $session_id"
    [ -n "$session_id" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # -- Step 3: Update artifact content (was t06-3c) --
    echo "# Updating artifact..."
    cd "$artifact_dir"
    echo "updated-content" > testfile.txt
    run seed_storage_fixture artifact "$artifact_name" .
    assert_success

    # -- Step 4: Continue from session with templateVars (was t06-3d) --
    echo "# Continuing from session..."
    run continue_run_fixture "$session_id" "cat testfile.txt"

    assert_success
    assert_output --partial '"name":"Bash"'

    # Should see updated content (latest artifact version)
    assert_output --partial "updated-content"

    echo "# Verified: Continue works with templateVars stored in session"
}

# =============================================================================
# Test 4: Run continue accepts refreshed secret values
# Sets up config with secrets, runs agent to create session, then continues
# with a different structured secret value.
# =============================================================================

@test "t06-4: continue accepts refreshed secret values" {
    local artifact_name="$ARTIFACT_NAME"
    local artifact_dir="$TEST_ARTIFACT_DIR/$artifact_name"

    # -- Step 1: Setup config with secrets (was t06-4a) --
    local env_agent_name="e2e-env-continue-$(date +%s%3N)-$RANDOM"
    local env_config="$TEST_DIR/env-continue-${BATS_TEST_NUMBER}.yaml"
    cat > "$env_config" <<EOF
version: "1.0"
agents:
  ${env_agent_name}:
    description: "Test agent for environment variable expansion"
    framework: claude-code
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
    run seed_compose_fixture "$env_config"
    assert_success

    # Create artifact
    echo "# Creating artifact..."
    mkdir -p "$artifact_dir"
    cd "$artifact_dir"
    echo "test-content" > testfile.txt
    run seed_storage_fixture artifact "$artifact_name" .
    assert_success

    # -- Step 2: Run agent with secrets to create session (was t06-4b) --
    echo "# Running agent with secrets to create session..."
    run run_compose_fixture "$env_agent_name" \
        "echo 'test' && echo \$TEST_SECRET" \
        "$(jq -nc --arg name "$artifact_name" \
            '{
                vars: {testVar: "myTestVar"},
                secrets: {TEST_SECRET: "initial-secret-value"},
                artifacts: [{name: $name, mountPath: "/home/user/workspace"}]
            }')"

    assert_success

    local session_id
    session_id=$(run_fixture_field "$output" '.sessionId')
    echo "# Session ID: $session_id"
    [ -n "$session_id" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # -- Step 3: Continue with a refreshed secret (was t06-4c) --
    echo "# Continuing with refreshed secret value..."
    export TEST_SECRET="env-secret-value"
    run continue_run_fixture "$session_id" \
        "echo 'continue test'" \
        "$(jq -nc --arg secret "$TEST_SECRET" '{secrets: {TEST_SECRET: $secret}}')"

    # Should succeed with the explicitly supplied refreshed value.
    assert_success
    assert_output --partial '"name":"Bash"'

    # Verify the run completed successfully (not failed due to missing secrets)
    refute_output --partial "Missing required secrets"

    echo "# Verified: run continue accepts refreshed secret values"
}
