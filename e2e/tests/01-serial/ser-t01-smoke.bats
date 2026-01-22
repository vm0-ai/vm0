#!/usr/bin/env bats
# Smoke tests for CLI basic functionality
# Note: Tests run with -T flag to display execution timing

load '../../helpers/setup'

@test "CLI shows help with --help flag" {
    run $CLI_COMMAND --help
    assert_success
    assert_output --partial "Usage: vm0"
}
