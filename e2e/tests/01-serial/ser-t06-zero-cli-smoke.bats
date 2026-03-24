#!/usr/bin/env bats
# Smoke tests for the zero CLI binary entry point
# Verifies the zero binary works independently from vm0

load '../../helpers/setup'

@test "zero --help shows schedule, agent, org commands" {
    run zero --help
    assert_success
    assert_output --partial "schedule"
    assert_output --partial "agent"
    assert_output --partial "org"
}

@test "zero --help does not show compose, volume, artifact commands" {
    run zero --help
    assert_success
    refute_output --partial "compose"
    refute_output --partial "volume"
    refute_output --partial "artifact"
}

@test "zero --version outputs version" {
    run zero --version
    assert_success
    assert_output --regexp '^[0-9]+\.[0-9]+\.[0-9]+'
}

@test "zero agent list returns successfully" {
    run zero agent list
    assert_success
}

@test "zero schedule list returns successfully" {
    run zero schedule list
    assert_success
}
