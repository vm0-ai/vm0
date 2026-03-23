#!/usr/bin/env bats

# Test VM0 organization switching commands (Happy Path Only)
#
# This test covers issue #2792: organization support with Clerk integration
#
# Note: Organization creation/status tests are NOT included in E2E because they
# require real Clerk Organizations API calls, which the E2E test user cannot perform.
# Those flows are fully covered by integration tests in:
# - turbo/apps/web/app/api/zero/org/__tests__/*.test.ts
# - turbo/apps/cli/src/commands/zero/org/__tests__/*.test.ts

load '../../helpers/setup'

# ============================================
# Organization Switching Tests
# ============================================

@test "vm0 zero org use --personal switches back to personal scope" {
    if [ "${VM0_EXPERIMENTAL_ORG_SCOPE:-}" != "1" ]; then
        skip "VM0_EXPERIMENTAL_ORG_SCOPE not enabled"
    fi
    run $CLI_COMMAND zero org use --personal
    assert_success
    assert_output --partial "personal scope"
}
