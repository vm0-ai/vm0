#!/usr/bin/env bats

load '../../helpers/setup'

# Variable command tests - CRUD operations only
# Validation tests (help text, name validation, error handling) are in unit tests:
# turbo/apps/cli/src/commands/zero/variable/__tests__/*.test.ts

# Generate unique variable name for each test run to avoid conflicts
setup() {
    export TEST_VAR_NAME="E2E_TEST_VAR_$(date +%s%3N)_$RANDOM"
}

teardown() {
    # Clean up test variable if it exists
    $ZERO_CLI variable delete -y "$TEST_VAR_NAME" 2>/dev/null || true
}

@test "zero variable --help shows command description" {
    run $ZERO_CLI variable --help
    assert_success
    assert_output --partial "Read or write non-sensitive configuration values"
    assert_output --partial "list"
    assert_output --partial "set"
    assert_output --partial "delete"
}

@test "zero variable set creates a variable" {
    run $ZERO_CLI variable set "$TEST_VAR_NAME" "test-variable-value"
    assert_success
    assert_output --partial "Variable \"$TEST_VAR_NAME\" saved"
}

@test "zero variable list shows created variable with value" {
    # First create a variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "my-test-value" --description "E2E test"

    # Then list variables - should show the value (unlike secrets)
    run $ZERO_CLI variable list
    assert_success
    assert_output --partial "$TEST_VAR_NAME"
    assert_output --partial "my-test-value"
    assert_output --partial "E2E test"
    assert_output --partial "variable(s)"
}

@test "zero variable ls works as alias for list" {
    # First create a variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "alias-test-value"

    # List using ls alias
    run $ZERO_CLI variable ls
    assert_success
    assert_output --partial "$TEST_VAR_NAME"
    assert_output --partial "alias-test-value"
}

@test "zero variable set updates existing variable" {
    # Create initial variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "initial-value"

    # Update it
    run $ZERO_CLI variable set "$TEST_VAR_NAME" "updated-value" --description "Updated"
    assert_success
    assert_output --partial "Variable \"$TEST_VAR_NAME\" saved"

    # Verify value and description were updated
    run $ZERO_CLI variable list
    assert_output --partial "updated-value"
    assert_output --partial "Updated"
}

@test "zero variable delete removes variable" {
    # Create a variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "to-be-deleted"

    # Delete it (use -y to skip confirmation)
    run $ZERO_CLI variable delete -y "$TEST_VAR_NAME"
    assert_success
    assert_output --partial "Variable \"$TEST_VAR_NAME\" deleted"

    # Verify it's gone
    run $ZERO_CLI variable list
    assert_success
    refute_output --partial "$TEST_VAR_NAME"
}

# ============================================================================
# Variable Expansion Tests
# These tests verify that variable values are expanded in agent environment
# ============================================================================

@test "vm0 run expands server-stored variables" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique identifiers for this test
    local unique_id="$(date +%s%3N)-$RANDOM"
    local var_value="var-value-${unique_id}"
    local artifact_name="e2e-var-expand-${unique_id}"
    local agent_name="e2e-var-expand-${unique_id}"
    local test_artifact_dir="$(mktemp -d)"
    local test_config="$(mktemp --suffix=.yaml)"

    # Create test volume
    create_test_volume "e2e-vol-var-expand"

    # Step 1: Create a server-stored variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "$var_value"

    # Step 2: Create config that uses the variable
    cat > "$test_config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E test agent for variable expansion"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      MY_VAR: "\${{ vars.$TEST_VAR_NAME }}"
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
    $VM0_CLI artifact init --name "$artifact_name" >/dev/null 2>&1
    echo "test content" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1

    # Step 4: Build the compose
    run $VM0_CLI compose "$test_config"
    assert_success

    # Step 5: Run agent that echoes the variable value
    echo "# Running agent that echoes variable value..."
    run $VM0_CLI run "$agent_name" \
        --artifact-name "$artifact_name" \
        "echo MY_VAR=\$MY_VAR"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify variable value is expanded (NOT masked like secrets)
    assert_output --partial "MY_VAR=${var_value}"

    # Cleanup
    rm -rf "$test_artifact_dir"
    rm -f "$test_config"
    cleanup_test_volume
}

@test "vm0 run CLI vars override server-stored variables" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique identifiers for this test
    local unique_id="$(date +%s%3N)-$RANDOM"
    local server_value="server-value-${unique_id}"
    local cli_value="cli-value-${unique_id}"
    local artifact_name="e2e-var-override-${unique_id}"
    local agent_name="e2e-var-override-${unique_id}"
    local test_artifact_dir="$(mktemp -d)"
    local test_config="$(mktemp --suffix=.yaml)"

    # Create test volume
    create_test_volume "e2e-vol-var-override"

    # Step 1: Create a server-stored variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "$server_value"

    # Step 2: Create config that uses the variable
    cat > "$test_config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E test agent for variable override"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      MY_VAR: "\${{ vars.$TEST_VAR_NAME }}"
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
    $VM0_CLI artifact init --name "$artifact_name" >/dev/null 2>&1
    echo "test content" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1

    # Step 4: Build the compose
    run $VM0_CLI compose "$test_config"
    assert_success

    # Step 5: Run agent with CLI --vars to override server value
    echo "# Running agent with CLI var override..."
    run $VM0_CLI run "$agent_name" \
        --vars "$TEST_VAR_NAME=$cli_value" \
        --artifact-name "$artifact_name" \
        "echo MY_VAR=\$MY_VAR"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify CLI value is used (overrides server-stored value)
    assert_output --partial "MY_VAR=${cli_value}"
    refute_output --partial "MY_VAR=${server_value}"

    # Cleanup
    rm -rf "$test_artifact_dir"
    rm -f "$test_config"
    cleanup_test_volume
}
