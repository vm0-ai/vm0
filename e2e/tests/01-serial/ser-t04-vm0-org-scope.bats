#!/usr/bin/env bats

# Test VM0 organization scope commands (Happy Path Only)
# Tests the CLI for managing organization scopes
#
# This test covers issue #2792: organization scope support with Clerk integration
#
# Error handling and edge cases are covered by integration tests in:
# - turbo/apps/web/app/api/org/__tests__/*.test.ts
# - turbo/apps/cli/src/commands/scope/__tests__/*.test.ts
# - turbo/apps/cli/src/commands/scope/org/__tests__/*.test.ts

load '../../helpers/setup'

setup() {
    # Generate a unique slug for this test run to avoid conflicts
    export ORG_SLUG="e2e-org-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # No cleanup needed - orgs are user-specific
    true
}

teardown_file() {
    # Switch back to personal scope for subsequent tests
    $CLI_COMMAND scope use --personal >/dev/null 2>&1 || true
}

# ============================================
# Organization Creation Tests
# ============================================

@test "vm0 scope org create creates a new organization" {
    run $CLI_COMMAND scope org create "$ORG_SLUG"
    assert_success
    assert_output --partial "$ORG_SLUG"
    assert_output --partial "created"
}

# ============================================
# Organization Status Tests
# ============================================

@test "vm0 scope org status shows organization info" {
    # Ensure org exists and scope is active
    $CLI_COMMAND scope org create "$ORG_SLUG" >/dev/null 2>&1 || true

    run $CLI_COMMAND scope org status
    assert_success
    assert_output --partial "Members"
}

# ============================================
# Scope Switching Tests
# ============================================

@test "vm0 scope use --personal switches back to personal scope" {
    run $CLI_COMMAND scope use --personal
    assert_success
    assert_output --partial "personal scope"
}
