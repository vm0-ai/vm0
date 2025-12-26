#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG_TEMPLATE="${TEST_ROOT}/fixtures/configs/vm0-template-validation.yaml"
}

# Template variable validation tests for vm0 run

@test "vm0 run should fail when template variables are missing" {
    # First build the config
    run $CLI_COMMAND compose "$TEST_CONFIG_TEMPLATE"
    assert_success

    # Then try to run without providing template vars
    # Note: --artifact-name is required for run command, so provide a dummy one
    run $CLI_COMMAND run vm0-template-validation --artifact-name test-artifact "echo hello"
    assert_failure
    assert_output --partial "Missing required template variables"
    assert_output --partial "userName"
}