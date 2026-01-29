#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 onboard and vm0 setup-claude command tests
# E2E tests focus on: help output and command behavior
# Unit tests cover: auth checks, model provider checks, interactive prompts
# NOTE: Plugin installation requires Claude CLI to be available

setup() {
    # Create a temporary directory for each test
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR"
}

teardown() {
    # Clean up the temporary directory
    cd /
    rm -rf "$TEST_DIR"
}

# Check if Claude CLI is available
claude_available() {
    command -v claude &> /dev/null
}

# =============================================================================
# vm0 onboard tests
# =============================================================================

@test "vm0 onboard --help shows command description" {
    run $CLI_COMMAND onboard --help
    assert_success
    assert_output --partial "Guided setup for new VM0 users"
    assert_output --partial "--yes"
    assert_output --partial "--name"
}

@test "vm0 onboard -y creates agent directory and installs plugin" {
    if ! claude_available; then
        skip "Claude CLI not available"
    fi

    run $CLI_COMMAND onboard -y
    assert_success
    assert_output --partial "Created my-vm0-agent/"
    assert_output --partial "Installed vm0@vm0-skills"
    assert_output --partial "Next step:"
    assert_output --partial "cd my-vm0-agent"
    assert_output --partial "/vm0-agent"

    # Verify directory was created
    [ -d "my-vm0-agent" ]
}

@test "vm0 onboard -y --name creates custom named agent" {
    if ! claude_available; then
        skip "Claude CLI not available"
    fi

    run $CLI_COMMAND onboard -y --name custom-agent
    assert_success
    assert_output --partial "Created custom-agent/"
    assert_output --partial "Installed vm0@vm0-skills"
    assert_output --partial "cd custom-agent"

    # Verify directory was created with custom name
    [ -d "custom-agent" ]
}

@test "vm0 onboard fails if agent directory exists" {
    # Create existing directory
    mkdir my-vm0-agent

    run $CLI_COMMAND onboard -y
    assert_failure
    assert_output --partial "my-vm0-agent/ already exists"
}

# =============================================================================
# vm0 setup-claude tests
# =============================================================================

@test "vm0 setup-claude --help shows command description" {
    run $CLI_COMMAND setup-claude --help
    assert_success
    assert_output --partial "Install VM0 Claude Plugin"
    assert_output --partial "--scope"
}

@test "vm0 setup-claude installs VM0 plugin" {
    if ! claude_available; then
        skip "Claude CLI not available"
    fi

    run $CLI_COMMAND setup-claude
    assert_success
    assert_output --partial "Installed vm0@vm0-skills"
    assert_output --partial "Next step:"
    assert_output --partial "/vm0-agent"
}

@test "vm0 setup-claude with --scope user" {
    if ! claude_available; then
        skip "Claude CLI not available"
    fi

    run $CLI_COMMAND setup-claude --scope user
    assert_success
    assert_output --partial "Installed vm0@vm0-skills"
}
