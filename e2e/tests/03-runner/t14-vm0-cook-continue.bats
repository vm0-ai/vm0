#!/usr/bin/env bats

load '../../helpers/setup'

# Tests for cook subcommand help and option verification
# Error handling tests have been moved to unit tests in:
# turbo/apps/cli/src/commands/__tests__/cook.test.ts

@test "cook subcommands help is available" {
    run $CLI_COMMAND cook --help
    assert_success
    assert_output --partial "logs"
    assert_output --partial "continue"
    assert_output --partial "resume"
    assert_output --partial "View logs from the last cook run"
    assert_output --partial "Continue from the last session"
    assert_output --partial "Resume from the last checkpoint"
}

@test "cook logs supports vm0 logs options" {
    run $CLI_COMMAND cook logs --help
    assert_success
    assert_output --partial "--agent"
    assert_output --partial "--system"
    assert_output --partial "--metrics"
    assert_output --partial "--network"
    assert_output --partial "--since"
    assert_output --partial "--tail"
    assert_output --partial "--head"
}
