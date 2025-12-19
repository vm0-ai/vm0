#!/usr/bin/env bats

load '../../helpers/setup'

# Auth command tests

@test "vm0 auth --help shows available auth commands" {
    run $CLI_COMMAND auth --help
    assert_success
    assert_output --partial "login"
    assert_output --partial "logout"
    assert_output --partial "status"
    assert_output --partial "setup-token"
}

@test "vm0 auth setup-token --help shows command description" {
    run $CLI_COMMAND auth setup-token --help
    assert_success
    assert_output --partial "Output auth token for CI/CD environments"
}

@test "vm0 auth setup-token outputs token with human-readable format when authenticated" {
    # This test assumes the CLI is already authenticated (done in CI setup)
    run $CLI_COMMAND auth setup-token
    assert_success
    # Check for human-readable output format
    assert_output --partial "Authentication token exported successfully"
    assert_output --partial "Your token:"
    assert_output --partial "vm0_live_"
    assert_output --partial "export VM0_TOKEN=<token>"
}

@test "vm0 auth status shows authenticated status" {
    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Authenticated"
}
