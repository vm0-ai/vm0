#!/usr/bin/env bats

load '../../helpers/setup'

# Usage command E2E tests
# Note: Date validation, format acceptance, and error message tests are covered
# by unit tests in turbo/apps/cli/src/commands/__tests__/usage.test.ts

@test "vm0 usage --help shows command description" {
    run $CLI_COMMAND usage --help
    assert_success
    assert_output --partial "View usage statistics"
    assert_output --partial "--since"
    assert_output --partial "--until"
}

@test "vm0 usage returns usage data with default 7 day range" {
    run $CLI_COMMAND usage
    assert_success
    # Should show header with date range
    assert_output --partial "Usage Summary"
    # Should show column headers
    assert_output --partial "DATE"
    assert_output --partial "RUNS"
    assert_output --partial "RUN TIME"
    # Should show total row
    assert_output --partial "TOTAL"
}
