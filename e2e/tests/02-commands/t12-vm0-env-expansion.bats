#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-env-expansion.yaml"
    export UNIQUE_ID="$(date +%s)"
    export SECRET_VALUE="secret-value-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-env-test-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

# Environment variable expansion tests

@test "vm0 secret set creates a new secret" {
    # Use unique secret name to ensure it's new
    local SECRET_NAME="NEW_SECRET_${UNIQUE_ID}"
    run $CLI_COMMAND secret set "$SECRET_NAME" "$SECRET_VALUE"
    assert_success
    assert_output --partial "Secret created: ${SECRET_NAME}"
}

@test "vm0 secret list shows the created secret" {
    # Ensure secret exists
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    run $CLI_COMMAND secret list
    assert_success
    assert_output --partial "TEST_SECRET"
}

@test "vm0 secret delete removes an existing secret" {
    # Use unique secret name
    local SECRET_NAME="DELETE_SECRET_${UNIQUE_ID}"

    # Create a secret to delete
    $CLI_COMMAND secret set "$SECRET_NAME" "to-be-deleted" >/dev/null 2>&1

    # Verify it exists
    run $CLI_COMMAND secret list
    assert_success
    assert_output --partial "$SECRET_NAME"

    # Delete it
    run $CLI_COMMAND secret delete "$SECRET_NAME"
    assert_success
    assert_output --partial "Secret deleted: ${SECRET_NAME}"

    # Verify it's gone
    run $CLI_COMMAND secret list
    assert_success
    refute_output --partial "$SECRET_NAME"
}

@test "vm0 secret delete fails for non-existent secret" {
    run $CLI_COMMAND secret delete NONEXISTENT_SECRET_12345
    assert_failure
    assert_output --partial "Secret not found"
}

@test "vm0 secret set updates existing secret" {
    # Use unique secret name
    local SECRET_NAME="UPDATE_SECRET_${UNIQUE_ID}"

    # Create initial secret
    run $CLI_COMMAND secret set "$SECRET_NAME" "initial-value"
    assert_success
    assert_output --partial "Secret created: ${SECRET_NAME}"

    # Update it
    run $CLI_COMMAND secret set "$SECRET_NAME" "updated-value"
    assert_success
    assert_output --partial "Secret updated: ${SECRET_NAME}"
}

@test "vm0 run expands vars and masks secrets in environment" {
    # 1. Set up the secret
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    # 2. Create and push artifact
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    # 3. Build the compose
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # 4. Run with vars and echo the environment variables
    run $CLI_COMMAND run vm0-env-expansion \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    # 5. Verify vars are expanded normally
    assert_output --partial "VAR=${VAR_VALUE}"

    # 6. Verify secrets are masked in output (not showing raw value)
    # The secret value should be replaced with *** for security
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${SECRET_VALUE}"
}

@test "vm0 run fails when required secret is missing" {
    # Build compose that requires a secret that doesn't exist
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Delete the secret if it exists
    $CLI_COMMAND secret delete TEST_SECRET >/dev/null 2>&1 || true

    # Try to run - should fail because secret is missing
    run $CLI_COMMAND run vm0-env-expansion \
        --vars "testVar=somevalue" \
        --artifact-name "e2e-env-test-missing" \
        "echo hello"
    assert_failure
    assert_output --partial "Missing required secrets"
    assert_output --partial "TEST_SECRET"
}

@test "vm0 run fails when required vars are missing" {
    # Ensure secret exists
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    # Build compose
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Try to run without --vars - should fail
    run $CLI_COMMAND run vm0-env-expansion \
        --artifact-name "e2e-env-test-missing-vars" \
        "echo hello"
    assert_failure
    assert_output --partial "Missing required template variables"
    assert_output --partial "testVar"
}
