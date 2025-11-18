#!/usr/bin/env bats

load '../../helpers/setup'

# Note: These tests require a running VM0 API server with valid credentials
# Set VM0_API_URL and VM0_API_KEY environment variables before running

setup() {
    # Skip tests if API credentials not set
    if [ -z "$VM0_API_URL" ] || [ -z "$VM0_API_KEY" ]; then
        skip "VM0_API_URL or VM0_API_KEY not set"
    fi
}

@test "vm0 run shows error without API key" {
    # Temporarily unset API key
    old_key="$VM0_API_KEY"
    unset VM0_API_KEY

    run $CLI_COMMAND run cfg-test-123 "test prompt"

    # Restore API key
    export VM0_API_KEY="$old_key"

    assert_failure
    assert_output --partial "VM0_API_KEY"
}

@test "vm0 run shows error with invalid agent config ID" {
    # This test requires a real API server
    skip "Requires running API server with database"

    run $CLI_COMMAND run cfg-nonexistent "test prompt"
    assert_failure
    # Should show 404 hint
    assert_output --partial "404"
}

@test "vm0 run fails with invalid dynamic vars JSON" {
    run $CLI_COMMAND run cfg-test-123 "test prompt" --dynamicVars "invalid-json"
    assert_failure
    assert_output --partial "Invalid JSON"
}

@test "vm0 run accepts valid dynamic vars JSON" {
    # This test would require a real API server and valid config
    skip "Requires running API server with database"

    run $CLI_COMMAND run cfg-test-123 "Hello {{name}}" --dynamicVars '{"name":"World"}'
    # Would assert success if API was available
}

@test "vm0 run shows help with --help flag" {
    run $CLI_COMMAND run --help
    assert_success
    assert_output --partial "Run an agent with a prompt"
}

@test "vm0 run with valid config executes agent" {
    # This test requires a real API server with valid agent config
    skip "Requires running API server with database and valid agent config"

    run $CLI_COMMAND run cfg-test-123 "echo 'Hello World'"
    assert_success
    assert_output --partial "Runtime created:"
    assert_output --partial "Output:"
}

@test "vm0 run with --json flag outputs JSON" {
    # This test requires a real API server with valid agent config
    skip "Requires running API server with database and valid agent config"

    run $CLI_COMMAND run cfg-test-123 "test" --json
    assert_success
    # Output should be valid JSON
    assert_output --regexp '\{"runtimeId":"rt-'
}

@test "vm0 run with --verbose flag shows detailed information" {
    # This test requires a real API server with valid agent config
    skip "Requires running API server with database and valid agent config"

    run $CLI_COMMAND run cfg-test-123 "test" --verbose
    assert_success
    assert_output --partial "Runtime ID:"
    assert_output --partial "Sandbox ID:"
    assert_output --partial "Status:"
    assert_output --partial "Execution Time:"
}

@test "vm0 run displays helpful hints for common errors" {
    # Test 401 hint
    skip "Requires mocking API responses or specific API setup"

    # Would test that 401 errors show "Check your VM0_API_KEY"
    # Would test that 404 errors show "Agent config not found"
    # Would test that ECONNREFUSED shows "Cannot connect to VM0 API"
}
