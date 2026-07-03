#!/usr/bin/env bats
# Smoke tests for the zero CLI binary entry point
# Verifies the zero binary works independently from vm0

load '../../helpers/setup'

@test "zero --help shows automation, agent, org commands" {
    run $ZERO_CLI --help
    assert_success
    assert_output --partial "automation"
    assert_output --partial "agent"
    assert_output --partial "org"
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

@test "zero agent list returns successfully" {
    run $ZERO_CLI agent list
    assert_success
}

@test "zero automation list returns successfully" {
    run $ZERO_CLI automation list
    assert_success
}
