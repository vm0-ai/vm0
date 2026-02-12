#!/usr/bin/env bats

# Test VM0 scope switching commands (Happy Path Only)
#
# This test covers issue #2792: organization scope support with Clerk integration
#
# Note: Organization creation/status tests are NOT included in E2E because they
# require real Clerk Organizations API calls, which the E2E test user cannot perform.
# Those flows are fully covered by integration tests in:
# - turbo/apps/web/app/api/org/__tests__/*.test.ts
# - turbo/apps/cli/src/commands/scope/__tests__/*.test.ts
# - turbo/apps/cli/src/commands/scope/org/__tests__/*.test.ts

load '../../helpers/setup'

# ============================================
# Scope Switching Tests
# ============================================

@test "vm0 scope use --personal switches back to personal scope" {
    if [ "${VM0_EXPERIMENTAL_ORG_SCOPE:-}" != "1" ]; then
        skip "VM0_EXPERIMENTAL_ORG_SCOPE not enabled"
    fi
    run $CLI_COMMAND scope use --personal
    assert_success
    assert_output --partial "personal scope"
}
