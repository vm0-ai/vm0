#!/usr/bin/env bats

# Test VM0 scope commands
# Tests the CLI for managing user scopes/namespaces
#
# This test covers issue #628: scope/namespace system

load '../../helpers/setup'

setup() {
    # Generate a unique slug for this test run to avoid conflicts
    export TEST_SLUG="e2e-test-$(date +%s)"
}

teardown() {
    # No cleanup needed - scopes are user-specific
    true
}

# ============================================
# CLI Help Tests (fast, no network)
# ============================================

@test "vm0 scope --help shows available subcommands" {
    run $CLI_COMMAND scope --help
    assert_success
    assert_output --partial "status"
    assert_output --partial "set"
}

@test "vm0 scope status --help shows usage" {
    run $CLI_COMMAND scope status --help
    assert_success
    assert_output --partial "View current scope status"
}

@test "vm0 scope set --help shows usage" {
    run $CLI_COMMAND scope set --help
    assert_success
    assert_output --partial "Set your scope slug"
    assert_output --partial "--force"
    assert_output --partial "--display-name"
}

# ============================================
# Scope Status Tests (requires network)
# ============================================

@test "vm0 scope status shows scope info or setup instructions" {
    run $CLI_COMMAND scope status

    # Either shows scope info or tells user to set one up
    # Both are valid responses
    if [[ $status -eq 0 ]]; then
        # User has a scope configured
        assert_output --partial "Scope Information"
        assert_output --partial "@"
    else
        # User has no scope configured
        assert_output --partial "No scope configured"
        assert_output --partial "vm0 scope set"
    fi
}

# ============================================
# Scope Set Validation Tests (no destructive changes)
# ============================================

@test "vm0 scope set rejects slug that is too short" {
    run $CLI_COMMAND scope set "ab"
    assert_failure
    # Should fail validation before even trying to create
}

@test "vm0 scope set rejects reserved vm0 prefix" {
    run $CLI_COMMAND scope set "vm0test"
    assert_failure
    assert_output --partial "reserved"
}

@test "vm0 scope set rejects reserved system slug" {
    run $CLI_COMMAND scope set "system"
    assert_failure
    assert_output --partial "reserved"
}

@test "vm0 scope set rejects slug with invalid characters" {
    run $CLI_COMMAND scope set "Test_Slug"
    assert_failure
    # Should fail validation (uppercase or underscore)
}

# ============================================
# Note: We don't test scope creation/update in E2E
# because it would permanently change the test user's scope.
# Those flows are tested in unit/integration tests.
# ============================================
