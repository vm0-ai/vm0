#!/usr/bin/env bats

load '../../helpers/setup'

# Secret command tests - CRUD operations only
# Validation tests (help text, name validation, error handling) are in unit tests:
# turbo/apps/cli/src/commands/zero/secret/__tests__/*.test.ts

# ============================================================================
# File-level setup: create volume, compose config, and artifact ONCE for all
# heavy (vm0 run) tests. Lightweight CRUD tests don't need these resources.
# ============================================================================

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume once for all vm0 run tests
    export VOLUME_NAME="e2e-vol-secret-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create artifact once
    export ARTIFACT_NAME="e2e-secret-art-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null

    # Create compose config for single-secret masking test
    export AGENT_MASK="e2e-secret-mask-${UNIQUE_ID}"
    export CONFIG_MASK="$TEST_DIR/mask.yaml"
    cat > "$CONFIG_MASK" <<EOF
version: "1.0"
agents:
  ${AGENT_MASK}:
    description: "E2E test agent for secret masking"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      MY_SECRET: "\${{ secrets.MY_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$CONFIG_MASK" >/dev/null

    # Create compose config for multi-secret masking test
    export AGENT_MULTI="e2e-secret-multi-${UNIQUE_ID}"
    export CONFIG_MULTI="$TEST_DIR/multi.yaml"
    cat > "$CONFIG_MULTI" <<EOF
version: "1.0"
agents:
  ${AGENT_MULTI}:
    description: "E2E test agent for multiple secrets"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      API_KEY: "\${{ secrets.API_KEY }}"
      CLI_SECRET: "\${{ secrets.CLI_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$CONFIG_MULTI" >/dev/null
}

# Generate unique secret name for each test run to avoid conflicts
setup() {
    export TEST_SECRET_NAME="E2E_TEST_SECRET_$(date +%s%3N)_$RANDOM"
}

teardown() {
    # Filesystem-only cleanup — no API calls during per-test teardown
    :
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "zero secret --help shows command description" {
    run $ZERO_CLI secret --help
    assert_success
    assert_output --partial "Read or write secrets (API keys, tokens)"
    assert_output --partial "list"
    assert_output --partial "set"
    assert_output --partial "delete"
}

@test "zero secret set creates a secret" {
    run $ZERO_CLI secret set "$TEST_SECRET_NAME" --body "test-secret-value"
    assert_success
    assert_output --partial "Secret \"$TEST_SECRET_NAME\" saved"

    # Clean up inline since teardown no longer does API calls
    $ZERO_CLI secret delete -y "$TEST_SECRET_NAME" 2>/dev/null || true
}

@test "zero secret list shows created secret" {
    # First create a secret
    $ZERO_CLI secret set "$TEST_SECRET_NAME" --body "secret-value" --description "E2E test"

    # Then list secrets
    run $ZERO_CLI secret list
    assert_success
    assert_output --partial "$TEST_SECRET_NAME"
    assert_output --partial "E2E test"
    assert_output --partial "secret(s)"

    $ZERO_CLI secret delete -y "$TEST_SECRET_NAME" 2>/dev/null || true
}

@test "zero secret ls works as alias for list" {
    # First create a secret
    $ZERO_CLI secret set "$TEST_SECRET_NAME" --body "secret-value"

    # List using ls alias
    run $ZERO_CLI secret ls
    assert_success
    assert_output --partial "$TEST_SECRET_NAME"

    $ZERO_CLI secret delete -y "$TEST_SECRET_NAME" 2>/dev/null || true
}

@test "zero secret set updates existing secret" {
    # Create initial secret
    $ZERO_CLI secret set "$TEST_SECRET_NAME" --body "initial-value"

    # Update it
    run $ZERO_CLI secret set "$TEST_SECRET_NAME" --body "updated-value" --description "Updated"
    assert_success
    assert_output --partial "Secret \"$TEST_SECRET_NAME\" saved"

    # Verify description was updated
    run $ZERO_CLI secret list
    assert_output --partial "Updated"

    $ZERO_CLI secret delete -y "$TEST_SECRET_NAME" 2>/dev/null || true
}

@test "zero secret delete removes secret" {
    # Create a secret
    $ZERO_CLI secret set "$TEST_SECRET_NAME" --body "to-be-deleted"

    # Delete it (use -y to skip confirmation)
    run $ZERO_CLI secret delete -y "$TEST_SECRET_NAME"
    assert_success
    assert_output --partial "Secret \"$TEST_SECRET_NAME\" deleted"

    # Verify it's gone
    run $ZERO_CLI secret list
    assert_success
    refute_output --partial "$TEST_SECRET_NAME"
}

# ============================================================================
# Secret Masking Tests
# These tests verify that secret values are masked in agent output.
# Heavy setup (volume, compose, artifact) is shared via setup_file().
# ============================================================================

@test "vm0 run masks secret values in output" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    local secret_value="secret-${UNIQUE_ID}"

    # Run agent with secret provided via CLI
    echo "# Running agent that echoes secret value..."
    run $VM0_CLI run "$AGENT_MASK" \
        --secrets "MY_SECRET=${secret_value}" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo SECRET=\$MY_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify secret value is masked
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${secret_value}"
}

@test "vm0 run masks multiple CLI secrets in output" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    local secret1_value="secret1-${UNIQUE_ID}"
    local secret2_value="secret2-${UNIQUE_ID}"

    # Run agent with multiple CLI secrets
    echo "# Running agent with multiple CLI secrets..."
    run $VM0_CLI run "$AGENT_MULTI" \
        --secrets "API_KEY=${secret1_value}" \
        --secrets "CLI_SECRET=${secret2_value}" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo API_KEY=\$API_KEY && echo CLI_SECRET=\$CLI_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Both secrets should be masked
    assert_output --partial "API_KEY=***"
    assert_output --partial "CLI_SECRET=***"

    # Neither actual value should appear
    refute_output --partial "${secret1_value}"
    refute_output --partial "${secret2_value}"
}
