#!/usr/bin/env bats

# Test VM0 model provider commands (happy path)
#
# This test covers PR #1452: Model provider entity + CLI
#
# Simplified in issue #1522: reduced from 18 tests to 3 happy-path tests

load '../../helpers/setup'

setup() {
    export TEST_CREDENTIAL_VALUE="test-api-key-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up test provider created during tests
    $CLI_COMMAND model-provider delete "anthropic-api-key" 2>/dev/null || true
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
