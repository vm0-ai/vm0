#!/usr/bin/env bats

# Test VM0 org commands (Happy Path Only)
# Tests the CLI for managing user organizations/namespaces
#
# This test covers issue #628: org/namespace system
#
# Note: Slug validation tests (length, reserved words, invalid characters)
# are covered by unit tests in:
# - turbo/apps/web/src/lib/org/__tests__/org-service.test.ts
# - turbo/apps/cli/src/commands/zero/org/__tests__/set.test.ts
#
# Error handling tests have been moved to CLI integration tests:
# - turbo/apps/cli/src/commands/run/__tests__/index.test.ts
#   - "should show error when org does not exist" (org not found)
# - turbo/apps/cli/src/commands/zero/org/__tests__/set.test.ts
#   - "should require --force to update existing organization"

load '../../helpers/setup'

setup() {
    # Generate a unique slug for this test run to avoid conflicts
    export TEST_SLUG="e2e-test-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # No cleanup needed - organizations are user-specific
    true
}

# ============================================
# Organization Status Tests (requires network)
# ============================================

@test "vm0 zero org status shows organization info or setup instructions" {
    run $CLI_COMMAND zero org status

    # Either shows org info or tells user to set one up
    # Both are valid responses
    if [[ $status -eq 0 ]]; then
        # User has an organization configured
        assert_output --partial "Organization Information"
        assert_output --partial "Slug:"
    else
        # User has no organization configured
        assert_output --partial "No organization configured"
        assert_output --partial "vm0 zero org set"
    fi
}

# ============================================
# Compose Tests
# ============================================

@test "vm0 compose succeeds with minimal config" {
    TEST_DIR="$(mktemp -d)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  test-agent:
    framework: claude-code
EOF

    # Should succeed - image is resolved server-side based on framework
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    rm -rf "$TEST_DIR"
}

# ============================================
# Organization Creation and Update Tests (CI has isolated DB)
# ============================================

@test "vm0 zero org set creates new organization successfully" {
    # First check if user already has an organization
    run $CLI_COMMAND zero org status

    if [[ $status -eq 0 ]]; then
        # User already has organization, need to update with --force
        run $CLI_COMMAND zero org set "$TEST_SLUG" --force
    else
        # No organization yet, create new one
        run $CLI_COMMAND zero org set "$TEST_SLUG"
    fi

    assert_success
    assert_output --partial "$TEST_SLUG"
}

@test "vm0 zero org status shows newly created organization" {
    # Ensure organization exists first
    run $CLI_COMMAND zero org status
    if [[ $status -ne 0 ]]; then
        $CLI_COMMAND zero org set "$TEST_SLUG" >/dev/null 2>&1
    fi

    run $CLI_COMMAND zero org status
    assert_success
    assert_output --partial "Organization Information"
    assert_output --partial "Slug:"
}

@test "vm0 zero org set updates organization with --force flag" {
    # Ensure organization exists
    run $CLI_COMMAND zero org status
    if [[ $status -ne 0 ]]; then
        $CLI_COMMAND zero org set "$TEST_SLUG" >/dev/null 2>&1
    fi

    # Update with --force
    NEW_SLUG="e2e-force-$(date +%s%3N)-$RANDOM"
    run $CLI_COMMAND zero org set "$NEW_SLUG" --force
    assert_success
    assert_output --partial "$NEW_SLUG"
}
