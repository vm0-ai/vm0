#!/usr/bin/env bats

load '../../helpers/setup'

@test "CLI shows help with --help flag" {
    run $CLI_COMMAND --help
    assert_success
    assert_output --partial "Usage: vm0"
}

@test "CLI shows version with --version flag" {
    run $CLI_COMMAND --version
    assert_success
    assert_output --partial "0.2.0"
}

@test "CLI create command shows help" {
    run $CLI_COMMAND create --help
    assert_success
    assert_output --partial "Create an agent config"
}

@test "CLI run command shows help" {
    run $CLI_COMMAND run --help
    assert_success
    assert_output --partial "Run an agent with a prompt"
}
