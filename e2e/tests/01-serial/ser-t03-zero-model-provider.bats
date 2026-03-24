#!/usr/bin/env bats

# Test VM0 org model provider commands (happy path)
#
# This test covers org-level model provider CLI (vm0 org model-provider)
#
# Updated for org-level migration: user-level model-provider was removed,
# all operations are now under `zero org model-provider`

load '../../helpers/setup'

setup() {
    export TEST_CREDENTIAL_VALUE="test-api-key-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up test provider created during tests
    $ZERO_CLI org model-provider remove "anthropic-api-key" 2>/dev/null || true
}

# ============================================================================
# Happy Path Tests
# ============================================================================

@test "zero org model-provider setup creates provider" {
    run $ZERO_CLI org model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "created"
}

@test "zero org model-provider ls shows created provider" {
    $ZERO_CLI org model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"

    run $ZERO_CLI org model-provider ls
    assert_success
    assert_output --partial "anthropic-api-key"
    assert_output --partial "claude-code"
}

@test "zero org model-provider remove removes provider" {
    $ZERO_CLI org model-provider setup --type "anthropic-api-key" --secret "$TEST_CREDENTIAL_VALUE"

    run $ZERO_CLI org model-provider remove "anthropic-api-key"
    assert_success
    assert_output --partial "removed"
}
