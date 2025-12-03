#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-env-expansion.yaml"
    export UNIQUE_ID="$(date +%s)"
    export SECRET_VALUE="secret-value-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
}

# Environment variable expansion tests

@test "vm0 secret set creates a new secret" {
    run $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE"
    assert_success
    assert_output --partial "Secret created: TEST_SECRET"
}

@test "vm0 secret list shows the created secret" {
    # Ensure secret exists
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    run $CLI_COMMAND secret list
    assert_success
    assert_output --partial "TEST_SECRET"
}

@test "vm0 run expands vars and secrets in environment" {
    # 1. Set up the secret
    $CLI_COMMAND secret set TEST_SECRET "$SECRET_VALUE" >/dev/null 2>&1

    # 2. Build the compose
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success

    # 3. Run with vars and echo the environment variables
    run $CLI_COMMAND run vm0-env-expansion \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "e2e-env-test-${UNIQUE_ID}" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    # 4. Verify the output contains the expanded values
    assert_output --partial "VAR=${VAR_VALUE}"
    assert_output --partial "SECRET=${SECRET_VALUE}"
}

@test "vm0 run fails when required secret is missing" {
    # Build compose that requires a secret that doesn't exist
    run $CLI_COMMAND build "$TEST_CONFIG"
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
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success

    # Try to run without --vars - should fail
    run $CLI_COMMAND run vm0-env-expansion \
        --artifact-name "e2e-env-test-missing-vars" \
        "echo hello"
    assert_failure
    assert_output --partial "Missing required template variables"
    assert_output --partial "testVar"
}
