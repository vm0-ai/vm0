#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG_ENV="${TEST_ROOT}/fixtures/configs/vm0-test-env-vars.yaml"
    export TEST_CONFIG_TPL="${TEST_ROOT}/fixtures/configs/vm0-test-volume-dynamic.yaml"

    # Clear env vars to test missing variable scenarios
    unset TEST_API_TOKEN
    unset TEST_DB_URL
}

# Environment variable validation tests for vm0 build

@test "vm0 build should fail when environment variables are missing" {
    run $CLI_COMMAND build "$TEST_CONFIG_ENV"
    assert_failure
    assert_output --partial "Missing required environment variables"
    assert_output --partial "TEST_API_TOKEN"
    assert_output --partial "TEST_DB_URL"
}

@test "vm0 build should fail when single environment variable is missing" {
    export TEST_API_TOKEN="test-token-value"
    # TEST_DB_URL is still unset

    run $CLI_COMMAND build "$TEST_CONFIG_ENV"
    assert_failure
    assert_output --partial "Missing required environment variables"
    assert_output --partial "TEST_DB_URL"
}

@test "vm0 build should succeed when all environment variables are set" {
    export TEST_API_TOKEN="test-token-value"
    export TEST_DB_URL="postgresql://localhost:5432/test"

    run $CLI_COMMAND build "$TEST_CONFIG_ENV"
    assert_success
    assert_output --partial "vm0-test-env-vars"
}

# Template variable validation tests for vm0 run

@test "vm0 run should fail when template variables are missing" {
    # First build the config
    run $CLI_COMMAND build "$TEST_CONFIG_TPL"
    assert_success

    # Then try to run without providing template vars
    run $CLI_COMMAND run vm0-test-volume-dynamic "list files"
    assert_failure
    assert_output --partial "Missing required template variables"
    assert_output --partial "userId"
}

@test "vm0 run should succeed when all template variables are provided" {
    # First build the config
    run $CLI_COMMAND build "$TEST_CONFIG_TPL"
    assert_success

    # Then run with template vars provided
    run $CLI_COMMAND run vm0-test-volume-dynamic -e userId=test-user-123 "echo 'test'"
    assert_success
}
