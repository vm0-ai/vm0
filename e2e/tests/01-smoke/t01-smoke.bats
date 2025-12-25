#!/usr/bin/env bats
# Smoke tests for CLI basic functionality

load '../../helpers/setup'

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
