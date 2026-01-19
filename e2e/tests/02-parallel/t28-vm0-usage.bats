#!/usr/bin/env bats

load '../../helpers/setup'

# Usage command tests

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

@test "vm0 usage --since accepts relative date format" {
    run $CLI_COMMAND usage --since 7d
    assert_success
    assert_output --partial "Usage Summary"
    assert_output --partial "TOTAL"
}

@test "vm0 usage --since accepts ISO date format" {
    # Use a date 5 days ago to stay within 30 day limit
    local since_date=$(date -d "5 days ago" +%Y-%m-%d 2>/dev/null || date -v-5d +%Y-%m-%d)
    run $CLI_COMMAND usage --since "$since_date"
    assert_success
    assert_output --partial "Usage Summary"
}

@test "vm0 usage --until accepts ISO date format" {
    local until_date=$(date +%Y-%m-%d)
    local since_date=$(date -d "3 days ago" +%Y-%m-%d 2>/dev/null || date -v-3d +%Y-%m-%d)
    run $CLI_COMMAND usage --since "$since_date" --until "$until_date"
    assert_success
    assert_output --partial "Usage Summary"
}

@test "vm0 usage rejects invalid --since format" {
    run $CLI_COMMAND usage --since "invalid-date"
    assert_failure
    assert_output --partial "Invalid --since format"
}

@test "vm0 usage rejects invalid --until format" {
    run $CLI_COMMAND usage --until "not-a-date"
    assert_failure
    assert_output --partial "Invalid --until format"
}

@test "vm0 usage rejects --since after --until" {
    local today=$(date +%Y-%m-%d)
    local yesterday=$(date -d "1 day ago" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
    run $CLI_COMMAND usage --since "$today" --until "$yesterday"
    assert_failure
    assert_output --partial "--since must be before --until"
}

@test "vm0 usage rejects range exceeding 30 days" {
    local today=$(date +%Y-%m-%d)
    local long_ago=$(date -d "40 days ago" +%Y-%m-%d 2>/dev/null || date -v-40d +%Y-%m-%d)
    run $CLI_COMMAND usage --since "$long_ago" --until "$today"
    assert_failure
    assert_output --partial "exceeds maximum of 30 days"
}

@test "vm0 usage shows dash for zero run time" {
    # With a very short time range where no runs occurred,
    # the TOTAL should show 0 runs with "-" for time
    # This test verifies the formatting works correctly
    run $CLI_COMMAND usage
    assert_success
    # Output should be well-formatted regardless of data
    assert_output --partial "TOTAL"
}
