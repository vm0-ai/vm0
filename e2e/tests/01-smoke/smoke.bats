#!/usr/bin/env bats

load '../../helpers/setup'

@test "CLI hello command shows welcome message" {
    run $CLI_COMMAND hello
    assert_success
    assert_output --partial "Welcome to the Vm0 CLI!"
}
