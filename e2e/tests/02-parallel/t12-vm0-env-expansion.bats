#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-t12"

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export SECRET_VALUE="secret-value-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-env-test-${UNIQUE_ID}"
    export AGENT_NAME="vm0-env-expansion-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export TEST_ENV_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_ARTIFACT_DIR/vm0-env-expansion.yaml"
}

# Helper to create config dynamically
create_env_expansion_config() {
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
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
}

teardown() {
    # Clean up temporary directories
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_ENV_DIR" ] && [ -d "$TEST_ENV_DIR" ]; then
        rm -rf "$TEST_ENV_DIR"
    fi
    # Clean up test volume
    cleanup_test_volume
}

# Helper to create artifact for tests
setup_artifact() {
    # Create config dynamically (each test needs its own due to parallel execution)
    create_env_expansion_config
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# Environment variable expansion tests with --secrets flag

@test "vm0 run expands vars and secrets via --secrets flag" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run with --vars and --secrets flags"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Verify vars are expanded"
    assert_output --partial "VAR=${VAR_VALUE}"

    echo "# Step 5: Verify secrets are masked in output"
    # The secret value should be replaced with *** for security
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${SECRET_VALUE}"
}

# Note: The following tests have been moved to unit tests in variable-expander.spec.ts:
# - "vm0 run loads secrets from environment variables"
# - "vm0 run loads vars from environment variables"
# - "vm0 run loads secrets from .env file"
# - "vm0 run --secrets flag takes priority over env vars"
# - "vm0 run fails when required secret is missing"
# - "vm0 run fails when required vars are missing"

@test "vm0 run with multiple --secrets flags" {
    echo "# Step 1: Create config with multiple secrets"
    local MULTI_SECRET_CONFIG="$(mktemp)"
    cat > "$MULTI_SECRET_CONFIG" <<EOF
version: "1.0"

agents:
  multi-secrets:
    description: "Test agent with multiple secrets"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      SECRET_A: "\${{ secrets.SECRET_A }}"
      SECRET_B: "\${{ secrets.SECRET_B }}"
    volumes:
      - claude-files:/home/user/.config/claude

volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Build the compose"
    run $CLI_COMMAND compose "$MULTI_SECRET_CONFIG"
    assert_success

    echo "# Step 4: Run with multiple --secrets flags"
    local SECRET_A_VALUE="secret-a-${UNIQUE_ID}"
    local SECRET_B_VALUE="secret-b-${UNIQUE_ID}"

    run $CLI_COMMAND run multi-secrets \
        --secrets "SECRET_A=${SECRET_A_VALUE}" \
        --secrets "SECRET_B=${SECRET_B_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo A=\$SECRET_A && echo B=\$SECRET_B"
    assert_success

    echo "# Step 5: Verify both secrets are masked"
    assert_output --partial "A=***"
    assert_output --partial "B=***"
    refute_output --partial "secret-a-"
    refute_output --partial "secret-b-"

    # Cleanup
    rm -f "$MULTI_SECRET_CONFIG"
}

@test "vm0 run continue requires secrets to be re-provided" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run initial session with secrets"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo INITIAL && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "INITIAL"
    assert_output --partial "SECRET=***"

    echo "# Step 4: Extract session ID"
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID from output:"
        echo "$output"
        return 1
    }
    echo "# Extracted session ID: $SESSION_ID"

    echo "# Step 5: Continue WITHOUT secrets fails with helpful message"
    # Secrets are never persisted - must be provided on every run
    run $CLI_COMMAND run continue "$SESSION_ID" \
        "echo CONTINUED"
    assert_failure
    assert_output --partial "Missing required secrets: TEST_SECRET"
    assert_output --partial "--secrets TEST_SECRET=<value>"

    echo "# Step 6: Continue WITH secrets succeeds"
    run $CLI_COMMAND run continue "$SESSION_ID" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --verbose \
        "echo CONTINUED && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "CONTINUED"
    assert_output --partial "SECRET=***"
}

@test "vm0 run resume requires secrets to be re-provided" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run initial session with secrets"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo INITIAL && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Extract checkpoint ID"
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID from output:"
        echo "$output"
        return 1
    }
    echo "# Extracted checkpoint ID: $CHECKPOINT_ID"

    echo "# Step 5: Resume WITHOUT secrets fails with helpful message"
    # Secrets are never persisted - must be provided on every run
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "echo RESUMED"
    assert_failure
    assert_output --partial "Missing required secrets: TEST_SECRET"
    assert_output --partial "--secrets TEST_SECRET=<value>"

    echo "# Step 6: Resume WITH secrets succeeds"
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --verbose \
        "echo RESUMED && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "RESUMED"
    assert_output --partial "SECRET=***"
}
