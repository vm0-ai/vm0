#!/usr/bin/env bats

# Test VM0 model provider commands
# Tests the CLI for managing model providers (LLM credentials)
#
# This test covers PR #1452: Model provider entity + CLI
# And sets up default provider for parallel tests (PR #1472)

load '../../helpers/setup'

# Generate unique test data for each test run to avoid conflicts
setup() {
    export TEST_CREDENTIAL_VALUE="test-api-key-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up test model providers created during individual tests
    # But NOT the stable provider set up in teardown_file
    # We only clean up anthropic-api-key and openai-api-key here
    # claude-code-oauth-token is managed by teardown_file for parallel tests
    $CLI_COMMAND model-provider delete "anthropic-api-key" 2>/dev/null || true
    $CLI_COMMAND model-provider delete "openai-api-key" 2>/dev/null || true
}

teardown_file() {
    # Set a stable model provider at the end for subsequent parallel tests to use
    # This ensures all tests in 02-parallel have a default LLM configuration
    # Using claude-code-oauth-token as the default for claude-code framework
    $CLI_COMMAND model-provider setup \
        --type "claude-code-oauth-token" \
        --credential "mock-oauth-token-for-e2e" >/dev/null 2>&1 || true
}

# ============================================================================
# Help Command Tests
# ============================================================================

@test "vm0 model-provider --help shows command description" {
    run $CLI_COMMAND model-provider --help
    assert_success
    assert_output --partial "Manage model providers"
    assert_output --partial "ls"
    assert_output --partial "setup"
    assert_output --partial "delete"
    assert_output --partial "set-default"
}

@test "vm0 model-provider ls --help shows options" {
    run $CLI_COMMAND model-provider ls --help
    assert_success
    assert_output --partial "List all model providers"
}

@test "vm0 model-provider setup --help shows usage" {
    run $CLI_COMMAND model-provider setup --help
    assert_success
    assert_output --partial "Configure a model provider"
    assert_output --partial "--type"
    assert_output --partial "--credential"
}

@test "vm0 model-provider delete --help shows usage" {
    run $CLI_COMMAND model-provider delete --help
    assert_success
    assert_output --partial "Delete a model provider"
    assert_output --partial "<type>"
}

@test "vm0 model-provider set-default --help shows usage" {
    run $CLI_COMMAND model-provider set-default --help
    assert_success
    assert_output --partial "Set a model provider as default for its framework"
    assert_output --partial "<type>"
}

# ============================================================================
# Setup Command Tests
# ============================================================================

@test "vm0 model-provider setup creates anthropic-api-key provider" {
    run $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "created"
}

@test "vm0 model-provider setup creates claude-code-oauth-token provider" {
    # First delete any existing one
    $CLI_COMMAND model-provider delete "claude-code-oauth-token" 2>/dev/null || true

    run $CLI_COMMAND model-provider setup --type "claude-code-oauth-token" --credential "$TEST_CREDENTIAL_VALUE"
    assert_success
    assert_output --partial "claude-code-oauth-token"
    assert_output --partial "created"
}

@test "vm0 model-provider setup creates openai-api-key provider" {
    run $CLI_COMMAND model-provider setup --type "openai-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    assert_success
    assert_output --partial "openai-api-key"
    assert_output --partial "created"
}

@test "vm0 model-provider setup updates existing provider" {
    # Create initial provider
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    # Update it
    local updated_value="updated-key-$(date +%s%3N)"
    run $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$updated_value"
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "updated"
}

@test "vm0 model-provider setup rejects invalid type" {
    run $CLI_COMMAND model-provider setup --type "invalid-type" --credential "$TEST_CREDENTIAL_VALUE"
    assert_failure
    assert_output --partial "Invalid"
}

# ============================================================================
# List Command Tests
# ============================================================================

@test "vm0 model-provider ls shows empty state" {
    # Clean up all providers first
    $CLI_COMMAND model-provider delete "anthropic-api-key" 2>/dev/null || true
    $CLI_COMMAND model-provider delete "claude-code-oauth-token" 2>/dev/null || true
    $CLI_COMMAND model-provider delete "openai-api-key" 2>/dev/null || true

    run $CLI_COMMAND model-provider ls
    assert_success
    # Should show "No model providers" when empty
    assert_output --partial "No model providers"
}

@test "vm0 model-provider ls shows created provider" {
    # Create a provider first
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND model-provider ls
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "claude-code"
    assert_output --partial "default"
}

@test "vm0 model-provider ls groups by framework" {
    # Create providers for different frameworks
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "openai-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND model-provider ls
    assert_success
    assert_output --partial "claude-code"
    assert_output --partial "codex"
}

# ============================================================================
# Delete Command Tests
# ============================================================================

@test "vm0 model-provider delete removes provider" {
    # Create a provider
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    # Delete it
    run $CLI_COMMAND model-provider delete "anthropic-api-key"
    assert_success
    assert_output --partial "deleted"

    # Verify it's gone by listing
    run $CLI_COMMAND model-provider ls
    assert_success
    refute_output --partial "anthropic-api-key"
}

@test "vm0 model-provider delete fails for non-existent provider" {
    # Make sure it doesn't exist
    $CLI_COMMAND model-provider delete "anthropic-api-key" 2>/dev/null || true

    run $CLI_COMMAND model-provider delete "anthropic-api-key"
    assert_failure
    assert_output --partial "not found"
}

# ============================================================================
# Set-Default Command Tests
# ============================================================================

@test "vm0 model-provider set-default changes default" {
    # First delete any existing claude-code-oauth-token
    $CLI_COMMAND model-provider delete "claude-code-oauth-token" 2>/dev/null || true

    # Create two providers for same framework
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "claude-code-oauth-token" --credential "$TEST_CREDENTIAL_VALUE"

    # Set second as default
    run $CLI_COMMAND model-provider set-default "claude-code-oauth-token"
    assert_success
    assert_output --partial "Default"
}

@test "vm0 model-provider set-default fails for non-existent provider" {
    # Make sure it doesn't exist
    $CLI_COMMAND model-provider delete "anthropic-api-key" 2>/dev/null || true

    run $CLI_COMMAND model-provider set-default "anthropic-api-key"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 model-provider set-default is idempotent" {
    # Create a provider (it will be default)
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    # Set it as default again (no-op)
    run $CLI_COMMAND model-provider set-default "anthropic-api-key"
    assert_success
    # Should succeed without error
}
