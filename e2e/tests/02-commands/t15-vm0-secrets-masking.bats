#!/usr/bin/env bats

load '../../helpers/setup'

# Test that secrets are masked in agent event output
# This verifies the secret-masker module is working correctly

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-env-expansion.yaml"
    export UNIQUE_ID="$(date +%s)"
    # Use a distinctive secret value that's easy to search for
    export SECRET_VALUE="super-secret-token-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-mask-test-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "vm0 run masks secrets in agent output" {
    echo "# Step 1: Set up the secret"
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 4: Run agent that echoes the secret value"
    # The agent will echo the secret, but it should be masked in the output
    run $CLI_COMMAND run vm0-env-expansion \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'The secret is: '\$TEST_SECRET"
    assert_success

    echo "# Step 5: Verify output contains masked placeholder"
    # The secret should be replaced with ***
    assert_output --partial "***"

    echo "# Step 6: Verify the actual secret value is NOT in output"
    # The raw secret value should NOT appear anywhere in the output
    refute_output --partial "$SECRET_VALUE"
}

@test "vm0 run masks Base64 encoded secrets in agent output" {
    echo "# Step 1: Set up the secret"
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 4: Run agent that outputs Base64 encoded secret"
    # The agent will base64 encode and echo the secret
    run $CLI_COMMAND run vm0-env-expansion \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo \$TEST_SECRET | base64"
    assert_success

    echo "# Step 5: Compute expected Base64 value"
    local BASE64_SECRET=$(echo -n "$SECRET_VALUE" | base64)

    echo "# Step 6: Verify Base64 encoded secret is NOT in output"
    # The Base64 encoded value should also be masked
    refute_output --partial "$BASE64_SECRET"
}

@test "vm0 run masks secrets appearing in command arguments" {
    echo "# Step 1: Set up the secret"
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 4: Run agent with secret in curl-like command"
    # Simulate a common pattern where secrets appear in command arguments
    run $CLI_COMMAND run vm0-env-expansion \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo \"curl -H 'Authorization: Bearer \$TEST_SECRET' https://api.example.com\""
    assert_success

    echo "# Step 5: Verify the secret is masked in command output"
    refute_output --partial "$SECRET_VALUE"
    # The curl command structure should still be visible
    assert_output --partial "Authorization: Bearer"
}
