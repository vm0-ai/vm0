#!/usr/bin/env bats

load '../../helpers/setup'

# Credential command tests - CRUD operations only
# Validation tests (help text, name validation, error handling) are in unit tests:
# turbo/apps/cli/src/__tests__/credential-command.test.ts

# Generate unique credential name for each test run to avoid conflicts
setup() {
    export TEST_CRED_NAME="E2E_TEST_CRED_$(date +%s%3N)_$RANDOM"
}

teardown() {
    # Clean up test credential if it exists
    $CLI_COMMAND credential delete -y "$TEST_CRED_NAME" 2>/dev/null || true
}

@test "vm0 credential --help shows command description" {
    run $CLI_COMMAND credential --help
    assert_success
    assert_output --partial "Manage stored credentials"
    assert_output --partial "list"
    assert_output --partial "set"
    assert_output --partial "delete"
}

@test "vm0 credential set creates a credential" {
    run $CLI_COMMAND credential set "$TEST_CRED_NAME" "test-secret-value"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" saved"
    assert_output --partial "Use in vm0.yaml"
    assert_output --partial "\${{ credentials.$TEST_CRED_NAME }}"
}

@test "vm0 credential list shows created credential" {
    # First create a credential
    $CLI_COMMAND credential set "$TEST_CRED_NAME" "secret-value" --description "E2E test"

    # Then list credentials
    run $CLI_COMMAND credential list
    assert_success
    assert_output --partial "$TEST_CRED_NAME"
    assert_output --partial "E2E test"
    assert_output --partial "credential(s)"
}

@test "vm0 credential ls works as alias for list" {
    # First create a credential
    $CLI_COMMAND credential set "$TEST_CRED_NAME" "secret-value"

    # List using ls alias
    run $CLI_COMMAND credential ls
    assert_success
    assert_output --partial "$TEST_CRED_NAME"
}

@test "vm0 credential set updates existing credential" {
    # Create initial credential
    $CLI_COMMAND credential set "$TEST_CRED_NAME" "initial-value"

    # Update it
    run $CLI_COMMAND credential set "$TEST_CRED_NAME" "updated-value" --description "Updated"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" saved"

    # Verify description was updated
    run $CLI_COMMAND credential list
    assert_output --partial "Updated"
}

@test "vm0 credential delete removes credential" {
    # Create a credential
    $CLI_COMMAND credential set "$TEST_CRED_NAME" "to-be-deleted"

    # Delete it (use -y to skip confirmation)
    run $CLI_COMMAND credential delete -y "$TEST_CRED_NAME"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" deleted"

    # Verify it's gone
    run $CLI_COMMAND credential list
    assert_success
    refute_output --partial "$TEST_CRED_NAME"
}

# ============================================================================
# Credential Masking Tests
# These tests verify that credential values are masked in agent output
# ============================================================================

@test "vm0 run masks credential values in output" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique identifiers for this test
    local unique_id="$(date +%s%3N)-$RANDOM"
    local cred_value="cred-secret-${unique_id}"
    local artifact_name="e2e-cred-mask-${unique_id}"
    local agent_name="e2e-cred-mask-agent"
    local test_artifact_dir="$(mktemp -d)"
    local test_config="$(mktemp --suffix=.yaml)"

    # Create test volume
    create_test_volume "e2e-vol-cred-mask"

    # Step 1: Create a credential in the platform
    echo "# Creating credential: $TEST_CRED_NAME"
    run $CLI_COMMAND credential set "$TEST_CRED_NAME" "$cred_value"
    assert_success

    # Step 2: Create config that uses the credential (without runner)
    cat > "$test_config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E test agent for credential masking"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      MY_CREDENTIAL: "\${{ credentials.${TEST_CRED_NAME} }}"
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

    # Step 5: Run agent that echoes credential value
    echo "# Running agent that echoes credential value..."
    run $CLI_COMMAND run "$agent_name" \
        --artifact-name "$artifact_name" \
        "echo CRED=\$MY_CREDENTIAL"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify credential value is masked
    assert_output --partial "CRED=***"
    refute_output --partial "CRED=${cred_value}"

    # Cleanup
    rm -rf "$test_artifact_dir"
    rm -f "$test_config"
    cleanup_test_volume
}

@test "vm0 run CLI secrets take priority over credentials" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique identifiers for this test
    local unique_id="$(date +%s%3N)-$RANDOM"
    local cred_value="cred-value-${unique_id}"
    local secret_value="cli-secret-${unique_id}"
    local artifact_name="e2e-cred-priority-${unique_id}"
    local agent_name="e2e-cred-priority-agent"
    local test_artifact_dir="$(mktemp -d)"
    local test_config="$(mktemp --suffix=.yaml)"

    # Create test volume
    create_test_volume "e2e-vol-cred-priority"

    # Step 1: Create a credential in the platform
    echo "# Creating credential: $TEST_CRED_NAME"
    run $CLI_COMMAND credential set "$TEST_CRED_NAME" "$cred_value"
    assert_success

    # Step 2: Create config that uses both a credential and a secret
    cat > "$test_config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E test agent for credential/secret priority"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: "\${{ credentials.${TEST_CRED_NAME} }}"
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
        --secrets "CLI_SECRET=${secret_value}" \
        --artifact-name "$artifact_name" \
        "echo API_KEY=\$API_KEY && echo CLI_SECRET=\$CLI_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Both credential and CLI secret should be masked
    assert_output --partial "API_KEY=***"
    assert_output --partial "CLI_SECRET=***"

    # Neither actual value should appear
    refute_output --partial "${cred_value}"
    refute_output --partial "${secret_value}"

    # Cleanup
    rm -rf "$test_artifact_dir"
    rm -f "$test_config"
    cleanup_test_volume
}
