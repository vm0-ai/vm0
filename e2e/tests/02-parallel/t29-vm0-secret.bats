#!/usr/bin/env bats

load '../../helpers/setup'

# Secret command tests - CRUD operations only
# Validation tests (help text, name validation, error handling) are in unit tests:
# turbo/apps/cli/src/commands/secret/__tests__/*.test.ts

# Generate unique secret name for each test run to avoid conflicts
setup() {
    export TEST_SECRET_NAME="E2E_TEST_SECRET_$(date +%s%3N)_$RANDOM"
}

teardown() {
    # Clean up test secret if it exists
    $CLI_COMMAND secret delete -y "$TEST_SECRET_NAME" 2>/dev/null || true
}

@test "vm0 secret --help shows command description" {
    run $CLI_COMMAND secret --help
    assert_success
    assert_output --partial "Manage stored secrets"
    assert_output --partial "list"
    assert_output --partial "set"
    assert_output --partial "delete"
}

@test "vm0 secret set creates a secret" {
    run $CLI_COMMAND secret set "$TEST_SECRET_NAME" "test-secret-value"
    assert_success
    assert_output --partial "Secret \"$TEST_SECRET_NAME\" saved"
    assert_output --partial "Use in vm0.yaml"
    assert_output --partial "\${{ secrets.$TEST_SECRET_NAME }}"
}

@test "vm0 secret list shows created secret" {
    # First create a secret
    $CLI_COMMAND secret set "$TEST_SECRET_NAME" "secret-value" --description "E2E test"

    # Then list secrets
    run $CLI_COMMAND secret list
    assert_success
    assert_output --partial "$TEST_SECRET_NAME"
    assert_output --partial "E2E test"
    assert_output --partial "secret(s)"
}

@test "vm0 secret ls works as alias for list" {
    # First create a secret
    $CLI_COMMAND secret set "$TEST_SECRET_NAME" "secret-value"

    # List using ls alias
    run $CLI_COMMAND secret ls
    assert_success
    assert_output --partial "$TEST_SECRET_NAME"
}

@test "vm0 secret set updates existing secret" {
    # Create initial secret
    $CLI_COMMAND secret set "$TEST_SECRET_NAME" "initial-value"

    # Update it
    run $CLI_COMMAND secret set "$TEST_SECRET_NAME" "updated-value" --description "Updated"
    assert_success
    assert_output --partial "Secret \"$TEST_SECRET_NAME\" saved"

    # Verify description was updated
    run $CLI_COMMAND secret list
    assert_output --partial "Updated"
}

@test "vm0 secret delete removes secret" {
    # Create a secret
    $CLI_COMMAND secret set "$TEST_SECRET_NAME" "to-be-deleted"

    # Delete it (use -y to skip confirmation)
    run $CLI_COMMAND secret delete -y "$TEST_SECRET_NAME"
    assert_success
    assert_output --partial "Secret \"$TEST_SECRET_NAME\" deleted"

    # Verify it's gone
    run $CLI_COMMAND secret list
    assert_success
    refute_output --partial "$TEST_SECRET_NAME"
}

# ============================================================================
# Secret Masking Tests
# These tests verify that secret values are masked in agent output
# ============================================================================

@test "vm0 run masks secret values in output" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique identifiers for this test
    local unique_id="$(date +%s%3N)-$RANDOM"
    local secret_value="secret-${unique_id}"
    local artifact_name="e2e-secret-mask-${unique_id}"
    local agent_name="e2e-secret-mask-agent"
    local test_artifact_dir="$(mktemp -d)"
    local test_config="$(mktemp --suffix=.yaml)"

    # Create test volume
    create_test_volume "e2e-vol-secret-mask"

    # Step 1: Create a secret in the platform
    echo "# Creating secret: $TEST_SECRET_NAME"
    run $CLI_COMMAND secret set "$TEST_SECRET_NAME" "$secret_value"
    assert_success

    # Step 2: Create config that uses the secret
    cat > "$test_config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E test agent for secret masking"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      MY_SECRET: "\${{ secrets.${TEST_SECRET_NAME} }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Step 3: Create artifact
    mkdir -p "$test_artifact_dir/$artifact_name"
    cd "$test_artifact_dir/$artifact_name"
    $CLI_COMMAND artifact init --name "$artifact_name" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    # Step 4: Build the compose
    run $CLI_COMMAND compose "$test_config"
    assert_success

    # Step 5: Run agent that echoes secret value
    echo "# Running agent that echoes secret value..."
    run $CLI_COMMAND run "$agent_name" \
        --artifact-name "$artifact_name" \
        "echo SECRET=\$MY_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify secret value is masked
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${secret_value}"

    # Cleanup
    rm -rf "$test_artifact_dir"
    rm -f "$test_config"
    cleanup_test_volume
}

@test "vm0 run CLI secrets take priority over platform secrets" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique identifiers for this test
    local unique_id="$(date +%s%3N)-$RANDOM"
    local platform_secret_value="platform-secret-${unique_id}"
    local cli_secret_value="cli-secret-${unique_id}"
    local artifact_name="e2e-secret-priority-${unique_id}"
    local agent_name="e2e-secret-priority-agent"
    local test_artifact_dir="$(mktemp -d)"
    local test_config="$(mktemp --suffix=.yaml)"

    # Create test volume
    create_test_volume "e2e-vol-secret-priority"

    # Step 1: Create a secret in the platform
    echo "# Creating platform secret: $TEST_SECRET_NAME"
    run $CLI_COMMAND secret set "$TEST_SECRET_NAME" "$platform_secret_value"
    assert_success

    # Step 2: Create config that uses both a platform secret and a CLI secret
    cat > "$test_config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E test agent for secret priority"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: "\${{ secrets.${TEST_SECRET_NAME} }}"
      CLI_SECRET: "\${{ secrets.CLI_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Step 3: Create artifact
    mkdir -p "$test_artifact_dir/$artifact_name"
    cd "$test_artifact_dir/$artifact_name"
    $CLI_COMMAND artifact init --name "$artifact_name" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    # Step 4: Build the compose
    run $CLI_COMMAND compose "$test_config"
    assert_success

    # Step 5: Run agent with CLI secret
    echo "# Running agent with CLI secret..."
    run $CLI_COMMAND run "$agent_name" \
        --secrets "CLI_SECRET=${cli_secret_value}" \
        --artifact-name "$artifact_name" \
        "echo API_KEY=\$API_KEY && echo CLI_SECRET=\$CLI_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Both platform secret and CLI secret should be masked
    assert_output --partial "API_KEY=***"
    assert_output --partial "CLI_SECRET=***"

    # Neither actual value should appear
    refute_output --partial "${platform_secret_value}"
    refute_output --partial "${cli_secret_value}"

    # Cleanup
    rm -rf "$test_artifact_dir"
    rm -f "$test_config"
    cleanup_test_volume
}
