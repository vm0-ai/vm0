#!/usr/bin/env bats

# Test VM0 scope commands (Happy Path Only)
# Tests the CLI for managing user scopes/namespaces
#
# This test covers issue #628: scope/namespace system
#
# Note: Slug validation tests (length, reserved words, invalid characters)
# are covered by unit tests in:
# - turbo/apps/web/src/lib/scope/__tests__/scope-service.spec.ts
# - turbo/apps/cli/src/commands/scope/__tests__/set.test.ts
#
# Error handling tests have been moved to CLI integration tests:
# - turbo/apps/cli/src/commands/run/__tests__/index.test.ts
#   - "should show error when scope does not exist" (scope not found)
# - turbo/apps/cli/src/commands/scope/__tests__/set.test.ts
#   - "should require --force to update existing scope"

load '../../helpers/setup'

setup() {
    # Generate a unique slug for this test run to avoid conflicts
    export TEST_SLUG="e2e-test-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # No cleanup needed - scopes are user-specific
    true
}

teardown_file() {
    # Set a stable scope at the end for subsequent parallel tests to use
    # This ensures all tests in 02-parallel have a consistent scope
    $CLI_COMMAND scope set "e2e-stable" --force >/dev/null 2>&1 || true
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
        assert_output --partial "Slug:"
    else
        # User has no scope configured
        assert_output --partial "No scope configured"
        assert_output --partial "vm0 scope set"
    fi
}

# ============================================
# Image Field Deprecation Tests
# ============================================

@test "vm0 compose with deprecated image field shows warning but succeeds" {
    # Create a test config with deprecated image field
    TEST_DIR="$(mktemp -d)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  test-agent:
    framework: claude-code
    image: "some-image"
EOF

    # Should succeed with deprecation warning
    # Server now resolves image based on framework, ignoring the image field
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    # Should show deprecation warning
    assert_output --partial "deprecated"

    rm -rf "$TEST_DIR"
}

@test "vm0 compose without image field succeeds" {
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
# Scope Creation and Update Tests (CI has isolated DB)
# ============================================

@test "vm0 scope set creates new scope successfully" {
    # First check if user already has a scope
    run $CLI_COMMAND scope status

    if [[ $status -eq 0 ]]; then
        # User already has scope, need to update with --force
        run $CLI_COMMAND scope set "$TEST_SLUG" --force
    else
        # No scope yet, create new one
        run $CLI_COMMAND scope set "$TEST_SLUG"
    fi

    assert_success
    assert_output --partial "$TEST_SLUG"
}

@test "vm0 scope status shows newly created scope" {
    # Ensure scope exists first
    run $CLI_COMMAND scope status
    if [[ $status -ne 0 ]]; then
        $CLI_COMMAND scope set "$TEST_SLUG" >/dev/null 2>&1
    fi

    run $CLI_COMMAND scope status
    assert_success
    assert_output --partial "Scope Information"
    assert_output --partial "Slug:"
}

@test "vm0 scope set updates scope with --force flag" {
    # Ensure scope exists
    run $CLI_COMMAND scope status
    if [[ $status -ne 0 ]]; then
        $CLI_COMMAND scope set "$TEST_SLUG" >/dev/null 2>&1
    fi

    # Update with --force
    NEW_SLUG="e2e-force-$(date +%s%3N)-$RANDOM"
    run $CLI_COMMAND scope set "$NEW_SLUG" --force
    assert_success
    assert_output --partial "$NEW_SLUG"
}

