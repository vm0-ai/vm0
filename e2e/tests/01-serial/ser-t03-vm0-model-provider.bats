#!/usr/bin/env bats

# Test VM0 org model provider commands (happy path)
#
# This test covers org-level model provider CLI (vm0 org model-provider)
#
# Updated for org-level migration: user-level model-provider was removed,
# all operations are now under `vm0 org model-provider`

load '../../helpers/setup'

setup() {
    export TEST_CREDENTIAL_VALUE="test-api-key-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up test provider created during tests
    $CLI_COMMAND org model-provider remove "anthropic-api-key" 2>/dev/null || true
}

# ============================================================================
# Happy Path Tests
# ============================================================================

@test "vm0 org model-provider setup creates provider" {
    run $CLI_COMMAND org model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "created"
}

@test "vm0 org model-provider ls shows created provider" {
    $CLI_COMMAND org model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND org model-provider ls
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "claude-code"
}

@test "vm0 org model-provider remove removes provider" {
    $CLI_COMMAND org model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND org model-provider remove "anthropic-api-key"
    assert_success
    assert_output --partial "removed"
}
