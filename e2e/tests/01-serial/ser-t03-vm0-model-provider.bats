#!/usr/bin/env bats

# Test VM0 model provider commands (happy path)
# Sets up default provider for parallel tests
#
# This test covers PR #1452: Model provider entity + CLI
# And sets up default provider for parallel tests (PR #1472)
#
# Simplified in issue #1522: reduced from 18 tests to 3 happy-path tests

load '../../helpers/setup'

setup() {
    export TEST_CREDENTIAL_VALUE="test-api-key-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up test provider (anthropic-api-key only)
    # claude-code-oauth-token is managed by teardown_file for parallel tests
    $CLI_COMMAND model-provider delete "anthropic-api-key" 2>/dev/null || true
}

teardown_file() {
    # Set a stable model provider at the end for subsequent parallel tests to use
    # This ensures all tests in 02-parallel have a default model provider configuration
    # Using claude-code-oauth-token as the default for claude-code framework
    $CLI_COMMAND model-provider setup \
        --type "claude-code-oauth-token" \
        --secret "mock-oauth-token-for-e2e" >/dev/null 2>&1 || true
}

# ============================================================================
# Happy Path Tests
# ============================================================================

@test "vm0 model-provider setup creates provider" {
    run $CLI_COMMAND model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "created"
}

@test "vm0 model-provider ls shows created provider" {
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND model-provider ls
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "claude-code"
    assert_output --partial "default"
}

@test "vm0 model-provider delete removes provider" {
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND model-provider delete "anthropic-api-key"
    assert_success
    assert_output --partial "deleted"
}
