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
        assert_output --partial "Slug:"
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
    # Use --force in case user already has a scope from prior tests
    run $CLI_COMMAND scope set "vm0test" --force
    assert_failure
    assert_output --partial "reserved"
}

@test "vm0 scope set rejects reserved system slug" {
    # Use --force in case user already has a scope from prior tests
    run $CLI_COMMAND scope set "system" --force
    assert_failure
    assert_output --partial "reserved"
}

@test "vm0 scope set rejects slug with invalid characters" {
    # Use --force in case user already has a scope from prior tests
    run $CLI_COMMAND scope set "Test_Slug" --force
    assert_failure
    # Should fail validation (uppercase or underscore)
}

# ============================================
# scope/name Image Reference Tests
# ============================================

@test "vm0 compose with scope/name validates format" {
    # Create a test config with scope/name format
    TEST_DIR="$(mktemp -d)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  test-agent:
    provider: claude-code
    image: "invalid/missing-image"
EOF

    # Should fail because the scope or image doesn't exist, not because of format
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    # Should show scope/image not found error, not a format error
    assert_output --partial "not found"

    rm -rf "$TEST_DIR"
}

@test "vm0 compose with plain image name that does not exist fails" {
    TEST_DIR="$(mktemp -d)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  test-agent:
    provider: claude-code
    image: "no-slash-here"
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    # Should fail due to image not found (plain name without slash is a user image lookup)

    rm -rf "$TEST_DIR"
}

@test "vm0 run with scope/name shows appropriate error for missing scope" {
    TEST_DIR="$(mktemp -d)"
    mkdir -p "$TEST_DIR/artifact"
    cd "$TEST_DIR/artifact"
    $CLI_COMMAND artifact init >/dev/null 2>&1 || true
    $CLI_COMMAND artifact push >/dev/null 2>&1 || true

    # Try to run with a non-existent scope
    run $CLI_COMMAND run "nonexistent-scope/test-image" \
        --artifact-name "e2e-scope-test-$(date +%s)" \
        "echo hello"

    # Should fail with scope not found
    assert_failure
    assert_output --partial "not found"

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

@test "vm0 scope set requires --force to update existing scope" {
    # Ensure scope exists
    run $CLI_COMMAND scope status
    if [[ $status -ne 0 ]]; then
        $CLI_COMMAND scope set "$TEST_SLUG" >/dev/null 2>&1
    fi

    # Try to update without --force (should fail)
    NEW_SLUG="e2e-update-$(date +%s)"
    run $CLI_COMMAND scope set "$NEW_SLUG"
    assert_failure
    assert_output --partial "--force"
}

@test "vm0 scope set updates scope with --force flag" {
    # Ensure scope exists
    run $CLI_COMMAND scope status
    if [[ $status -ne 0 ]]; then
        $CLI_COMMAND scope set "$TEST_SLUG" >/dev/null 2>&1
    fi

    # Update with --force
    NEW_SLUG="e2e-force-$(date +%s)"
    run $CLI_COMMAND scope set "$NEW_SLUG" --force
    assert_success
    assert_output --partial "$NEW_SLUG"
}

@test "vm0 scope set with --display-name sets custom name" {
    # Update scope with display name
    NEW_SLUG="e2e-display-$(date +%s)"
    run $CLI_COMMAND scope set "$NEW_SLUG" --display-name "My Test Scope" --force
    assert_success
    assert_output --partial "$NEW_SLUG"
}

# ============================================
# Full Image Build + @scope/name Workflow Tests
# ============================================

@test "vm0 image build creates image with scope association" {
    # Ensure user has a scope
    SCOPE_SLUG="e2e-img-$(date +%s)"
    run $CLI_COMMAND scope set "$SCOPE_SLUG" --force
    assert_success

    # Build an image using E2B base image (has required packages pre-installed)
    TEST_DIR="$(mktemp -d)"
    cat > "$TEST_DIR/Dockerfile" <<EOF
FROM e2bdev/code-interpreter:latest
RUN echo "scope-test-marker" > /tmp/scope-test.txt
EOF

    IMAGE_NAME="scope-test-img"
    run $CLI_COMMAND image build --file "$TEST_DIR/Dockerfile" --name "$IMAGE_NAME" --delete-existing
    assert_success
    assert_output --partial "Building image"
    assert_output --partial "Build ID"

    rm -rf "$TEST_DIR"
}

@test "vm0 image list shows images after build" {
    run $CLI_COMMAND image list
    assert_success
    # Should show at least one image (from previous test or existing)
}
