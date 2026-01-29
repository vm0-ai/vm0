#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 onboard and vm0 setup-claude command tests
# E2E tests focus on: help, happy path file creation
# Unit tests cover: auth checks, model provider checks, interactive prompts

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

@test "vm0 onboard -y creates agent directory with skill" {
    run $CLI_COMMAND onboard -y
    assert_success
    assert_output --partial "Created my-vm0-agent/"
    assert_output --partial "Installed vm0-cli skill"
    assert_output --partial "Next step:"
    assert_output --partial "cd my-vm0-agent"

    # Verify directory and skill were created
    [ -d "my-vm0-agent" ]
    [ -d "my-vm0-agent/.claude/skills/vm0-cli" ]
    [ -f "my-vm0-agent/.claude/skills/vm0-cli/SKILL.md" ]
}

@test "vm0 onboard -y --name creates custom named agent" {
    run $CLI_COMMAND onboard -y --name custom-agent
    assert_success
    assert_output --partial "Created custom-agent/"
    assert_output --partial "Installed vm0-cli skill"
    assert_output --partial "cd custom-agent"

    # Verify directory and skill were created with custom name
    [ -d "custom-agent" ]
    [ -d "custom-agent/.claude/skills/vm0-cli" ]
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
    assert_output --partial "Add/update Claude skill for VM0 CLI usage"
}

@test "vm0 setup-claude installs skill from GitHub" {
    run $CLI_COMMAND setup-claude
    assert_success
    assert_output --partial "Installed vm0-cli skill"
    assert_output --partial "Next step:"
    assert_output --partial "/vm0-cli"

    # Verify skill directory was created
    [ -d ".claude/skills/vm0-cli" ]
    [ -f ".claude/skills/vm0-cli/SKILL.md" ]

    # Verify skill content
    run cat .claude/skills/vm0-cli/SKILL.md
    assert_output --partial "name: vm0-cli"
    assert_output --partial "# VM0 CLI"
}

@test "vm0 setup-claude is idempotent (can run multiple times)" {
    # Run first time
    run $CLI_COMMAND setup-claude
    assert_success

    # Run second time - should succeed and overwrite
    run $CLI_COMMAND setup-claude
    assert_success
    assert_output --partial "Installed vm0-cli skill"
}
