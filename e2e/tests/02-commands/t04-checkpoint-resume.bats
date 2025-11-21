#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Set config path for checkpoint tests
    export TEST_CHECKPOINT_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-checkpoint.yaml"
}

@test "Build agent with GitHub volume for checkpoint testing" {
    run $CLI_COMMAND build "$TEST_CHECKPOINT_CONFIG"
    assert_success
    assert_output --partial "vm0-test-checkpoint"
}

@test "Run agent with GitHub volume - verify repository access" {
    # Test that GitHub volume is mounted and accessible
    run $CLI_COMMAND run vm0-test-checkpoint "List the files in the /home/user/repo directory and tell me if README.md exists"
    assert_success
    # Should access the GitHub repository volume
    assert_output --partial "README"
}

@test "Create checkpoint during agent execution" {
    # This test verifies that checkpoint creation works
    # In future implementation, this will test actual checkpoint API
    skip "Checkpoint creation API not yet implemented in CLI"
}

@test "Resume agent from checkpoint" {
    # This test verifies that resume from checkpoint works
    # In future implementation, this will test actual resume functionality
    skip "Checkpoint resume not yet implemented in CLI"
}

@test "Verify volume state preservation after checkpoint" {
    # This test verifies that GitHub volume state is preserved
    # In future implementation, this will test volume snapshots
    skip "Volume snapshot verification not yet implemented in CLI"
}
