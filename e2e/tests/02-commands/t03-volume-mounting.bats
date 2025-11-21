#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Set config paths for volume mounting tests
    export TEST_STATIC_VOLUME_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-volume-static.yaml"
    export TEST_DYNAMIC_VOLUME_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-volume-dynamic.yaml"
}

@test "Build agent with static volume configuration" {
    run $CLI_COMMAND build "$TEST_STATIC_VOLUME_CONFIG"
    assert_success
    assert_output --partial "vm0-test-volume-static"
}

@test "Run agent with static volume - read file from S3 volume" {
    run $CLI_COMMAND run vm0-test-volume-static "Read the file at /home/user/workspace/data/message.txt and output exactly what it says"
    assert_success
    assert_output --partial "Hello from S3 volume"
}

@test "Run agent with static volume - verify JSON file access" {
    run $CLI_COMMAND run vm0-test-volume-static "Read /home/user/workspace/data/config.json and tell me the value of the 'test' field"
    assert_success
    assert_output --partial "volume-mounting"
}

@test "Build agent with dynamic volume configuration" {
    run $CLI_COMMAND build "$TEST_DYNAMIC_VOLUME_CONFIG"
    assert_success
    assert_output --partial "vm0-test-volume-dynamic"
}

@test "Run agent with dynamic volume - pass userId variable" {
    run $CLI_COMMAND run vm0-test-volume-dynamic -e userId=test-user-123 "Read the file at /home/user/workspace/user-files/profile.json and tell me the userId value"
    assert_success
    assert_output --partial "test-user-123"
}

@test "Run agent with dynamic volume - verify user data access" {
    run $CLI_COMMAND run vm0-test-volume-dynamic -e userId=test-user-123 "List all files in /home/user/workspace/user-files/ directory"
    assert_success
    assert_output --partial "profile.json"
    assert_output --partial "README.md"
}
