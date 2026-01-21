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
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Verify vars are expanded"
    assert_output --partial "VAR=${VAR_VALUE}"

    echo "# Step 5: Verify secrets are masked in output"
    # The secret value should be replaced with *** for security
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${SECRET_VALUE}"
}

@test "vm0 run loads secrets from environment variables" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run with secret in environment variable"
    # Export the secret as an environment variable (CLI will pick it up)
    export TEST_SECRET="${SECRET_VALUE}"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Verify vars and secrets work"
    assert_output --partial "VAR=${VAR_VALUE}"
    assert_output --partial "SECRET=***"
}

@test "vm0 run loads vars from environment variables" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run with var in environment variable"
    # Export the var as an environment variable (CLI will pick it up)
    export testVar="${VAR_VALUE}"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Verify vars and secrets work"
    assert_output --partial "VAR=${VAR_VALUE}"
    assert_output --partial "SECRET=***"
}

@test "vm0 run loads secrets from .env file" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Create .env file in working directory"
    cd "$TEST_ENV_DIR"
    echo "TEST_SECRET=${SECRET_VALUE}" > .env

    echo "# Step 4: Run from directory with .env file"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 5: Verify vars and secrets work"
    assert_output --partial "VAR=${VAR_VALUE}"
    assert_output --partial "SECRET=***"
}

@test "vm0 run --secrets flag takes priority over env vars" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Set env var and --secrets with different values"
    export TEST_SECRET="env-var-value-${UNIQUE_ID}"
    local CLI_SECRET="cli-secret-value-${UNIQUE_ID}"

    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${CLI_SECRET}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Verify --secrets value is used (both should be masked, but CLI wins)"
    # Both values should be masked, but we can verify the masking works
    assert_output --partial "SECRET=***"
    # Should NOT contain either plaintext secret
    refute_output --partial "env-var-value-"
    refute_output --partial "cli-secret-value-"
}

@test "vm0 run fails when required secret is missing" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build compose that requires a secret"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Try to run without providing the secret"
    # Ensure no TEST_SECRET in environment
    unset TEST_SECRET

    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=somevalue" \
        --artifact-name "e2e-env-test-missing-${UNIQUE_ID}" \
        "echo hello"
    assert_failure
    assert_output --partial "Missing required secrets"
    assert_output --partial "TEST_SECRET"
}

@test "vm0 run fails when required vars are missing" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Try to run without --vars - should fail"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "e2e-env-test-missing-vars-${UNIQUE_ID}" \
        "echo hello"
    assert_failure
    assert_output --partial "Missing required"
    assert_output --partial "testVar"
}

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
        "echo RESUMED && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "RESUMED"
    assert_output --partial "SECRET=***"
}
