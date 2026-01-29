#!/usr/bin/env bats

# Test vm0 run list and vm0 run kill commands
#
# Note: These tests focus on command structure and basic functionality.
# Full integration tests with actual running runs would require the runner pipeline.

load '../../helpers/setup'

# ============================================
# Help and Command Structure Tests
# ============================================

@test "vm0 run list shows help with --help" {
    run $CLI_COMMAND run list --help
    assert_success
    assert_output --partial "List active runs"
}

@test "vm0 run list has 'ls' alias" {
    run $CLI_COMMAND run ls --help
    assert_success
    assert_output --partial "List active runs"
}

@test "vm0 run kill shows help with --help" {
    run $CLI_COMMAND run kill --help
    assert_success
    assert_output --partial "Kill (cancel) a pending or running run"
    assert_output --partial "<run-id>"
}

@test "vm0 run --help includes list and kill subcommands" {
    run $CLI_COMMAND run --help
    assert_success
    assert_output --partial "list"
    assert_output --partial "kill"
}

# ============================================
# List Command Tests
# ============================================

@test "vm0 run list executes successfully" {
    run $CLI_COMMAND run list
    assert_success
    # May show "No active runs" or a table - both are valid
}

@test "vm0 run list shows table headers when runs exist or 'No active runs' message" {
    run $CLI_COMMAND run list
    assert_success
    # Either shows "No active runs" or table headers
    if [[ "$output" != *"No active runs"* ]]; then
        assert_output --partial "ID"
        assert_output --partial "AGENT"
        assert_output --partial "STATUS"
        assert_output --partial "CREATED"
    fi
}

# ============================================
# Kill Command Error Handling Tests
# ============================================

@test "vm0 run kill requires run-id argument" {
    run $CLI_COMMAND run kill
    assert_failure
    assert_output --partial "run-id"
}

@test "vm0 run kill shows error for non-existent run" {
    run $CLI_COMMAND run kill "00000000-0000-0000-0000-000000000000"
    assert_failure
    assert_output --partial "Failed to kill run"
}

@test "vm0 run kill shows error for invalid run ID format" {
    run $CLI_COMMAND run kill "invalid-run-id"
    assert_failure
    assert_output --partial "Failed to kill run"
}
