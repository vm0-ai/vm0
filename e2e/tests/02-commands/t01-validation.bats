#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-git-artifact.yaml"
    export TEST_CONFIG_WITHOUT_TOKEN="${TEST_ROOT}/fixtures/configs/vm0-git-artifact-without-token.yaml"
}

# Environment variable validation tests for vm0 build

@test "vm0 build should fail when environment variables are missing" {
    run $CLI_COMMAND build "$TEST_CONFIG_WITHOUT_TOKEN"
    assert_failure
    assert_output --partial "Missing required environment variables"
    assert_output --partial "WITHOUT_TOKEN"
}

# Template variable validation tests for vm0 run

@test "vm0 run should fail when template variables are missing" {
    # First build the config
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success

    # Then try to run without providing template vars
    run $CLI_COMMAND run vm0-git-artifact "echo hello"
    assert_failure
    assert_output --partial "Missing required template variables"
    assert_output --partial "user"
}