#!/usr/bin/env bats

load '../../helpers/setup'

# Note: These tests require a running VM0 API server with valid credentials
# Set VM0_API_URL and VM0_API_KEY environment variables before running

@test "vm0 run shows error without API key" {
    # Temporarily unset API key
    old_key="$VM0_API_KEY"
    unset VM0_API_KEY

    run $CLI_COMMAND run 00000000-0000-0000-0000-000000000000 "test prompt"

    # Restore API key
    export VM0_API_KEY="$old_key"

    assert_failure
    assert_output --partial "VM0_API_KEY"
}

@test "vm0 run shows error with invalid agent config ID" {
    run $CLI_COMMAND run 00000000-0000-0000-0000-000000000000 "test prompt"
    assert_failure
    # Should show 404 hint
    assert_output --partial "404"
}

@test "vm0 run fails with invalid dynamic vars JSON" {
    run $CLI_COMMAND run 00000000-0000-0000-0000-000000000000 "test prompt" --dynamicVars "invalid-json"
    assert_failure
    assert_output --partial "Invalid JSON"
}

@test "vm0 run shows help with --help flag" {
    run $CLI_COMMAND run --help
    assert_success
    assert_output --partial "Run an agent with a prompt"
}
