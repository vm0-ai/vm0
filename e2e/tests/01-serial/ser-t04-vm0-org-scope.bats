#!/usr/bin/env bats

# Test VM0 organization scope commands (Happy Path Only)
# Tests the CLI for managing organizations and switching between scopes
#
# This test covers issue #2765: Organization scope support
#
# Note: Error handling tests (permission denied, invalid org, etc.) are covered
# by CLI integration tests in:
# - turbo/apps/cli/src/commands/scope/org/__tests__/*.test.ts
# - turbo/apps/web/app/api/org/__tests__/*.test.ts
#
# IMPORTANT: This test must run serially as it changes the active scope,
# which could affect other parallel tests.

load '../../helpers/setup'

setup_file() {
    # Generate a unique org slug for this test run
    export ORG_SLUG="e2e-org-$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="org-agent-$(date +%s%3N)-$RANDOM"
}

teardown_file() {
    # Restore to personal scope for subsequent tests
    # Using 'scope use' without argument switches back to personal scope
    $CLI_COMMAND scope use >/dev/null 2>&1 || true
}

# ============================================
# Organization Creation Tests
# ============================================

@test "vm0 scope org create creates organization successfully" {
    run $CLI_COMMAND scope org create "$ORG_SLUG"
    assert_success
    assert_output --partial "$ORG_SLUG"
    assert_output --partial "Organization created"
}

@test "vm0 scope org status shows organization info" {
    # Switch to org scope first
    $CLI_COMMAND scope use "$ORG_SLUG" >/dev/null 2>&1

    run $CLI_COMMAND scope org status
    assert_success
    assert_output --partial "Organization Information:"
    assert_output --partial "$ORG_SLUG"
    assert_output --partial "Members:"
    # Owner should be listed
    assert_output --partial "owner"
}

# Skip: invite test requires WEB_APP_URL to be configured in E2E environment
# This is covered by integration tests in turbo/apps/web/app/api/org/__tests__/invite.test.ts
# @test "vm0 scope org invite generates invite link" {
#     # Ensure we're in org scope
#     $CLI_COMMAND scope use "$ORG_SLUG" >/dev/null 2>&1
#
#     run $CLI_COMMAND scope org invite
#     assert_success
#     assert_output --partial "Invite link"
#     # Should contain a URL with /invite/ path
#     assert_output --regexp "https?://[^/]+/invite/[a-zA-Z0-9-]+"
# }

# ============================================
# Scope Listing Tests
# ============================================

@test "vm0 scope list shows organization in accessible scopes" {
    run $CLI_COMMAND scope list
    assert_success
    assert_output --partial "$ORG_SLUG"
    assert_output --partial "(org)"
    assert_output --partial "owner"
}

# ============================================
# Scope Switching Tests
# ============================================

@test "vm0 scope use switches to organization scope" {
    run $CLI_COMMAND scope use "$ORG_SLUG"
    assert_success
    assert_output --partial "Switched to scope"
    assert_output --partial "$ORG_SLUG"
    assert_output --partial "(organization)"
}

@test "vm0 scope use without argument switches to personal scope" {
    # First switch to org
    $CLI_COMMAND scope use "$ORG_SLUG" >/dev/null 2>&1

    # Then switch back to personal
    run $CLI_COMMAND scope use
    assert_success
    assert_output --partial "Switched to personal scope"
}

# ============================================
# Compose in Organization Scope Tests
# ============================================

@test "vm0 compose in org scope creates agent in organization" {
    # Switch to org scope
    $CLI_COMMAND scope use "$ORG_SLUG" >/dev/null 2>&1

    # Create test config
    TEST_DIR="$(mktemp -d)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent in org scope"
    framework: claude-code
EOF

    # Compose should use org scope
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    # Output should show org scope in the compose path
    assert_output --partial "$ORG_SLUG/$AGENT_NAME"

    rm -rf "$TEST_DIR"
}

@test "vm0 agent list in org scope shows org agents" {
    # Ensure we're in org scope
    $CLI_COMMAND scope use "$ORG_SLUG" >/dev/null 2>&1

    run $CLI_COMMAND agent list
    assert_success
    # Should show the agent we just created
    assert_output --partial "$AGENT_NAME"
}
