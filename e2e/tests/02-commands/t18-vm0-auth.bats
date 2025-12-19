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

@test "vm0 auth setup-token outputs token when authenticated" {
    # This test assumes the CLI is already authenticated (done in CI setup)
    run $CLI_COMMAND auth setup-token
    assert_success
    # Token should start with vm0_live_ prefix
    assert_output --regexp '^vm0_live_'
}

@test "vm0 auth status shows authenticated status" {
    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Authenticated"
}
