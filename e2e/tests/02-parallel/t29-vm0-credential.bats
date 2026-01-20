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
