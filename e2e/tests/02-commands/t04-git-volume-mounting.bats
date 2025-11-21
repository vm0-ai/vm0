#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Set config paths for git volume mounting tests
    export TEST_GIT_VOLUME_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-git-volume-test.yaml"
}

@test "Build agent with git volume configuration" {
    run $CLI_COMMAND build "$TEST_GIT_VOLUME_CONFIG"
    assert_success
    assert_output --partial "vm0-git-volume-test"
}

@test "Run agent with git volume - read file from cloned repository" {
    # Skip if CI_GITHUB_TOKEN is not set
    if [ -z "$CI_GITHUB_TOKEN" ]; then
        skip "CI_GITHUB_TOKEN not set, skipping git volume test"
    fi

    run $CLI_COMMAND run vm0-git-volume-test -e user=lancy "List all files in the current directory (pwd and ls -la), then read the question.md file and tell me what it says"
    assert_success
    assert_output --partial "1+1"
}
