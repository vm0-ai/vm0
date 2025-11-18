#!/usr/bin/env bats

load '../../helpers/setup'

# Note: These tests require a running VM0 API server with valid credentials
# Set VM0_API_URL and VM0_API_KEY environment variables before running

setup() {
    TEST_CONFIG="${TEST_ROOT}/fixtures/configs/test-agent.yaml"
}

@test "vm0 create shows error without API key" {
    # Temporarily unset API key
    old_key="$VM0_API_KEY"
    unset VM0_API_KEY

    run $CLI_COMMAND create "$TEST_CONFIG"

    # Restore API key
    export VM0_API_KEY="$old_key"

    assert_failure
    assert_output --partial "VM0_API_KEY"
}

@test "vm0 create fails with non-existent config file" {
    run $CLI_COMMAND create /path/to/nonexistent.yaml
    assert_failure
    assert_output --partial "Config file not found"
}

@test "vm0 create fails with invalid YAML" {
    # Create temporary invalid YAML file
    TEMP_FILE="$(mktemp)"
    echo "invalid: yaml: content: [" > "$TEMP_FILE"

    run $CLI_COMMAND create "$TEMP_FILE"

    rm "$TEMP_FILE"

    assert_failure
    assert_output --partial "Invalid YAML"
}

@test "vm0 create shows help with --help flag" {
    run $CLI_COMMAND create --help
    assert_success
    assert_output --partial "Create an agent config"
}

@test "vm0 create with valid config file creates agent config" {
    run $CLI_COMMAND create "$TEST_CONFIG"
    assert_success
    assert_output --partial "Agent Config ID:"
    # Verify UUID format (8-4-4-4-12 hex digits)
    assert_output --regexp "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
}

@test "vm0 create with --json flag outputs JSON" {
    run $CLI_COMMAND create "$TEST_CONFIG" --json
    assert_success
    # Verify JSON output with UUID format (with optional space after colon)
    assert_output --regexp '"agentConfigId": "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"'
    assert_output --regexp '"createdAt": "[0-9-]+T[0-9:.]+'
}
