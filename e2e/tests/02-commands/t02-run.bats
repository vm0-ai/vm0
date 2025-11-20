#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Build the test agent configuration before running tests
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-math.yaml"
}

@test "Build test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-test-math"
}

@test "Execute vm0 run with simple math task" {
    run $CLI_COMMAND run vm0-test-math "1+1=?"
    assert_success
    assert_output --partial "[result]"
}

@test "Verify run command completes without errors" {
    run $CLI_COMMAND run vm0-test-math "1+1=?"
    assert_success
    refute_output --partial "error"
    refute_output --partial "failed"
}
