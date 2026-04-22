#!/usr/bin/env bats

load '../../helpers/setup'

# Variable command tests - CRUD operations only
# Validation tests (help text, name validation, error handling) are in unit tests:
# turbo/apps/cli/src/commands/zero/variable/__tests__/*.test.ts

# ============================================================================
# File-level setup: create volume, compose config, and artifact ONCE for all
# heavy (vm0 run) tests. Lightweight CRUD tests don't need these resources.
# ============================================================================

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume once for all vm0 run tests
    export VOLUME_NAME="e2e-vol-var-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create artifact once
    export ARTIFACT_NAME="e2e-var-art-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null

    # Each vm0 run test gets its own unique variable name to avoid race conditions.
    # Variable names must contain only uppercase letters, numbers, and underscores,
    # so replace the hyphen in UNIQUE_ID with an underscore.
    local var_safe_id="${UNIQUE_ID//-/_}"
    export VAR_NAME_EXPAND="TEST_VAR_EXPAND_${var_safe_id}"
    export VAR_NAME_OVERRIDE="TEST_VAR_OVERRIDE_${var_safe_id}"

    # Create compose configs for both vm0 run tests
    export AGENT_EXPAND="e2e-var-expand-${UNIQUE_ID}"
    export CONFIG_EXPAND="$TEST_DIR/expand.yaml"
    cat > "$CONFIG_EXPAND" <<EOF
version: "1.0"
agents:
  ${AGENT_EXPAND}:
    description: "E2E test agent for variable expansion"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      MY_VAR: "\${{ vars.${VAR_NAME_EXPAND} }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$CONFIG_EXPAND" >/dev/null

    export AGENT_OVERRIDE="e2e-var-override-${UNIQUE_ID}"
    export CONFIG_OVERRIDE="$TEST_DIR/override.yaml"
    cat > "$CONFIG_OVERRIDE" <<EOF
version: "1.0"
agents:
  ${AGENT_OVERRIDE}:
    description: "E2E test agent for variable override"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      MY_VAR: "\${{ vars.${VAR_NAME_OVERRIDE} }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$CONFIG_OVERRIDE" >/dev/null
}

# Generate unique variable name for each test run to avoid conflicts
setup() {
    export TEST_VAR_NAME="E2E_TEST_VAR_$(date +%s%3N)_$RANDOM"
}

teardown() {
    # Filesystem-only cleanup — no API calls during per-test teardown
    :
}

teardown_file() {
    # Clean up variables used by vm0 run tests (one API call each, once)
    $ZERO_CLI variable delete -y "$VAR_NAME_EXPAND" 2>/dev/null || true
    $ZERO_CLI variable delete -y "$VAR_NAME_OVERRIDE" 2>/dev/null || true
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
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

    # Clean up inline since teardown no longer does API calls
    $ZERO_CLI variable delete -y "$TEST_VAR_NAME" 2>/dev/null || true
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

    $ZERO_CLI variable delete -y "$TEST_VAR_NAME" 2>/dev/null || true
}

@test "zero variable ls works as alias for list" {
    # First create a variable
    $ZERO_CLI variable set "$TEST_VAR_NAME" "alias-test-value"

    # List using ls alias
    run $ZERO_CLI variable ls
    assert_success
    assert_output --partial "$TEST_VAR_NAME"
    assert_output --partial "alias-test-value"

    $ZERO_CLI variable delete -y "$TEST_VAR_NAME" 2>/dev/null || true
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

    $ZERO_CLI variable delete -y "$TEST_VAR_NAME" 2>/dev/null || true
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
# These tests verify that variable values are expanded in agent environment.
# Heavy setup (volume, compose, artifact) is shared via setup_file().
# ============================================================================

@test "vm0 run expands server-stored variables" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    local var_value="var-value-${UNIQUE_ID}"

    # Set a server-stored variable (unique name per test to avoid races)
    $ZERO_CLI variable set "$VAR_NAME_EXPAND" "$var_value"

    # Run agent that echoes the variable value
    echo "# Running agent that echoes variable value..."
    run $VM0_CLI run "$AGENT_EXPAND" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo MY_VAR=\$MY_VAR"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify variable value is expanded (NOT masked like secrets)
    assert_output --partial "MY_VAR=${var_value}"
}

@test "vm0 run CLI vars override server-stored variables" {
    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    local server_value="server-value-${UNIQUE_ID}"
    local cli_value="cli-value-${UNIQUE_ID}"

    # Set a server-stored variable (unique name per test to avoid races)
    $ZERO_CLI variable set "$VAR_NAME_OVERRIDE" "$server_value"

    # Run agent with CLI --vars to override server value
    echo "# Running agent with CLI var override..."
    run $VM0_CLI run "$AGENT_OVERRIDE" \
        --vars "$VAR_NAME_OVERRIDE=$cli_value" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo MY_VAR=\$MY_VAR"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify CLI value is used (overrides server-stored value)
    assert_output --partial "MY_VAR=${cli_value}"
    refute_output --partial "MY_VAR=${server_value}"
}
