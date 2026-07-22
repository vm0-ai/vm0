#!/usr/bin/env bats
# Smoke tests for the zero CLI binary entry point
# Verifies the package exposes only the supported zero binary surface.

load '../../helpers/setup'

@test "zero --help shows supported commands" {
    run $ZERO_CLI --help
    assert_success
    assert_output --partial "workflow"
    assert_output --partial "agent"
    assert_output --partial "org"
    refute_output --partial "  automation"
    refute_output --partial "  schedule"
}

@test "zero --help does not show hidden or vm0-only commands" {
    run $ZERO_CLI --help
    assert_success
    refute_output --partial "  run"
    refute_output --partial "compose"
    refute_output --partial "volume"
    refute_output --partial "artifact"
}

@test "zero --version outputs version" {
    run $ZERO_CLI --version
    assert_success
    assert_output --regexp '^[0-9]+\.[0-9]+\.[0-9]+'
}

@test "zero automation is an unknown command" {
    run $ZERO_CLI automation list
    assert_failure
    assert_output --partial "unknown command 'automation'"
}

@test "zero schedule is an unknown command" {
    run $ZERO_CLI schedule list
    assert_failure
    assert_output --partial "unknown command 'schedule'"
}
