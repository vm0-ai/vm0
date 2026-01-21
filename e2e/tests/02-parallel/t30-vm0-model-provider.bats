#!/usr/bin/env bats

load '../../helpers/setup'

# Model Provider command tests

# Generate unique test data for each test run to avoid conflicts
setup() {
    export TEST_CREDENTIAL_VALUE="test-api-key-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up test model providers if they exist
    $CLI_COMMAND model-provider delete -y "anthropic-api-key" 2>/dev/null || true
    $CLI_COMMAND model-provider delete -y "claude-code-oauth-token" 2>/dev/null || true
    $CLI_COMMAND model-provider delete -y "openai-api-key" 2>/dev/null || true
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
    assert_output --partial "--json"
}

@test "vm0 model-provider setup --help shows usage" {
    run $CLI_COMMAND model-provider setup --help
    assert_success
    assert_output --partial "Set up a model provider"
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
    assert_output --partial "Set a model provider as default"
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
    run $CLI_COMMAND model-provider ls
    assert_success
    # Should either show providers or "No model providers" message
    [[ "$output" =~ "Model Providers:" ]] || [[ "$output" =~ "No model providers" ]]
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

@test "vm0 model-provider ls --json outputs valid JSON" {
    # Create a provider first
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    run $CLI_COMMAND model-provider ls --json
    assert_success

    # Verify JSON is valid and contains our provider
    echo "$output" | jq -e '.modelProviders[] | select(.type == "anthropic-api-key")'
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
    run $CLI_COMMAND model-provider delete -y "anthropic-api-key"
    assert_success
    assert_output --partial "deleted"

    # Verify it's gone
    run $CLI_COMMAND model-provider ls --json
    assert_success
    if echo "$output" | jq -e '.modelProviders[] | select(.type == "anthropic-api-key")' >/dev/null 2>&1; then
        fail "Provider should have been deleted"
    fi
}

@test "vm0 model-provider delete fails for non-existent provider" {
    run $CLI_COMMAND model-provider delete -y "anthropic-api-key"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 model-provider delete reassigns default" {
    # Create two providers for same framework
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "claude-code-oauth-token" --credential "$TEST_CREDENTIAL_VALUE"

    # Delete the first one (which is default)
    run $CLI_COMMAND model-provider delete -y "anthropic-api-key"
    assert_success

    # Verify second one is now default
    run $CLI_COMMAND model-provider ls --json
    assert_success
    local is_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "claude-code-oauth-token") | .isDefault')
    [[ "$is_default" == "true" ]]
}

# ============================================================================
# Set-Default Command Tests
# ============================================================================

@test "vm0 model-provider set-default changes default" {
    # Create two providers for same framework
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "claude-code-oauth-token" --credential "$TEST_CREDENTIAL_VALUE"

    # Verify first is default
    run $CLI_COMMAND model-provider ls --json
    local first_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "anthropic-api-key") | .isDefault')
    [[ "$first_default" == "true" ]]

    # Set second as default
    run $CLI_COMMAND model-provider set-default "claude-code-oauth-token"
    assert_success
    assert_output --partial "default"

    # Verify second is now default
    run $CLI_COMMAND model-provider ls --json
    local second_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "claude-code-oauth-token") | .isDefault')
    [[ "$second_default" == "true" ]]
}

@test "vm0 model-provider set-default fails for non-existent provider" {
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

# ============================================================================
# Framework Isolation Tests
# ============================================================================

@test "vm0 model-provider frameworks have separate defaults" {
    # Create providers for different frameworks
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "openai-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    # Both should be defaults for their respective frameworks
    run $CLI_COMMAND model-provider ls --json
    assert_success

    local anthropic_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "anthropic-api-key") | .isDefault')
    local openai_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "openai-api-key") | .isDefault')

    [[ "$anthropic_default" == "true" ]]
    [[ "$openai_default" == "true" ]]
}

@test "vm0 model-provider set-default only affects same framework" {
    # Create providers for both frameworks
    $CLI_COMMAND model-provider setup --type "anthropic-api-key" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "claude-code-oauth-token" --credential "$TEST_CREDENTIAL_VALUE"
    $CLI_COMMAND model-provider setup --type "openai-api-key" --credential "$TEST_CREDENTIAL_VALUE"

    # Set claude-code-oauth-token as default for claude-code
    run $CLI_COMMAND model-provider set-default "claude-code-oauth-token"
    assert_success

    # Verify openai is still default for codex
    run $CLI_COMMAND model-provider ls --json
    local openai_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "openai-api-key") | .isDefault')
    [[ "$openai_default" == "true" ]]

    # Verify anthropic is no longer default for claude-code
    local anthropic_default=$(echo "$output" | jq -r '.modelProviders[] | select(.type == "anthropic-api-key") | .isDefault')
    [[ "$anthropic_default" == "false" ]]
}
