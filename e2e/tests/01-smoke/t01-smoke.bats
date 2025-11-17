#!/usr/bin/env bats

load '../../helpers/setup'

@test "CLI hello command shows welcome message" {
    run $CLI_COMMAND hello
    assert_success
    assert_output --partial "Welcome to the Vm0 CLI!"
}

@test "CLI shows help with --help flag" {
    run $CLI_COMMAND --help
    assert_success
    assert_output --partial "Usage: vm0"
}

@test "CLI info command shows system information" {
    run $CLI_COMMAND info
    assert_success
    assert_output --partial "System Information:"
}
