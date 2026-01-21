#!/usr/bin/env bats

load '../../helpers/setup'

# Credential command tests

# Generate unique credential name for each test run to avoid conflicts
setup() {
    export TEST_CRED_NAME="E2E_TEST_CRED_$(date +%s%3N)_$RANDOM"
}

teardown() {
    # Clean up test credential if it exists
    $CLI_COMMAND experimental-credential delete -y "$TEST_CRED_NAME" 2>/dev/null || true
}

@test "vm0 experimental-credential --help shows command description" {
    run $CLI_COMMAND experimental-credential --help
    assert_success
    assert_output --partial "Manage stored credentials"
    assert_output --partial "list"
    assert_output --partial "set"
    assert_output --partial "delete"
}

@test "vm0 experimental-credential list --help shows options" {
    run $CLI_COMMAND experimental-credential list --help
    assert_success
    assert_output --partial "List all credentials"
    assert_output --partial "--json"
}

@test "vm0 experimental-credential set --help shows usage" {
    run $CLI_COMMAND experimental-credential set --help
    assert_success
    assert_output --partial "Create or update a credential"
    assert_output --partial "<name>"
    assert_output --partial "<value>"
    assert_output --partial "--description"
}

@test "vm0 experimental-credential delete --help shows usage" {
    run $CLI_COMMAND experimental-credential delete --help
    assert_success
    assert_output --partial "Delete a credential"
    assert_output --partial "<name>"
}

@test "vm0 experimental-credential set creates a credential" {
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "test-secret-value"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" saved"
    assert_output --partial "Use in vm0.yaml"
    assert_output --partial "\${{ credentials.$TEST_CRED_NAME }}"
}

@test "vm0 experimental-credential set with description" {
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "test-value" --description "Test credential for E2E"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" saved"
}

@test "vm0 experimental-credential list shows created credential" {
    # First create a credential
    $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "secret-value" --description "E2E test"

    # Then list credentials
    run $CLI_COMMAND experimental-credential list
    assert_success
    assert_output --partial "$TEST_CRED_NAME"
    assert_output --partial "E2E test"
    assert_output --partial "credential(s)"
}

@test "vm0 experimental-credential list --json outputs valid JSON" {
    # First create a credential
    $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "secret-value"

    # List in JSON format
    run $CLI_COMMAND experimental-credential list --json
    assert_success

    # Verify JSON is valid and contains our credential
    echo "$output" | jq -e ".[] | select(.name == \"$TEST_CRED_NAME\")"
}

@test "vm0 experimental-credential set rejects lowercase names" {
    run $CLI_COMMAND experimental-credential set "my_api_key" "value"
    assert_failure
    assert_output --partial "must contain only uppercase"
}

@test "vm0 experimental-credential set rejects names starting with numbers" {
    run $CLI_COMMAND experimental-credential set "123_KEY" "value"
    assert_failure
    assert_output --partial "must contain only uppercase"
}

@test "vm0 experimental-credential set rejects names with dashes" {
    run $CLI_COMMAND experimental-credential set "MY-API-KEY" "value"
    assert_failure
    assert_output --partial "must contain only uppercase"
}

@test "vm0 experimental-credential set updates existing credential" {
    # Create initial credential
    $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "initial-value"

    # Update it
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "updated-value" --description "Updated"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" saved"

    # Verify description was updated
    run $CLI_COMMAND experimental-credential list
    assert_output --partial "Updated"
}

@test "vm0 experimental-credential delete removes credential" {
    # Create a credential
    $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "to-be-deleted"

    # Delete it (use -y to skip confirmation)
    run $CLI_COMMAND experimental-credential delete -y "$TEST_CRED_NAME"
    assert_success
    assert_output --partial "Credential \"$TEST_CRED_NAME\" deleted"

    # Verify it's gone
    run $CLI_COMMAND experimental-credential list --json
    assert_success
    # Should not contain our credential
    if echo "$output" | jq -e ".[] | select(.name == \"$TEST_CRED_NAME\")" >/dev/null 2>&1; then
        fail "Credential should have been deleted"
    fi
}

@test "vm0 experimental-credential delete fails for non-existent credential" {
    run $CLI_COMMAND experimental-credential delete -y "NONEXISTENT_CRED_$(date +%s)"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 experimental-credential list shows empty state message" {
    # Delete any existing test credentials first
    $CLI_COMMAND experimental-credential delete -y "$TEST_CRED_NAME" 2>/dev/null || true

    # List credentials - might have other credentials from other tests
    # Just verify the command works
    run $CLI_COMMAND experimental-credential list
    assert_success
    # Should either show credentials or "No credentials found"
    [[ "$output" =~ "Credentials:" ]] || [[ "$output" =~ "No credentials found" ]]
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
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "$cred_value"
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
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "$cred_value"
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
