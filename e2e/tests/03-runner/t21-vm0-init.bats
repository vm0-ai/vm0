#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 init command tests
# E2E tests focus on: help, happy path file creation, and --force overwrite
# Other tests (validation, template content, short options) are covered by unit tests

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

@test "vm0 init --help shows command description" {
    run $CLI_COMMAND init --help
    assert_success
    assert_output --partial "Initialize a new VM0 project"
    assert_output --partial "--force"
    assert_output --partial "--name"
}

@test "vm0 init creates vm0.yaml and AGENTS.md with --name flag" {
    # Use --name flag for non-interactive mode (CI-friendly)
    run $CLI_COMMAND init --name test-agent
    assert_success
    assert_output --partial "Created vm0.yaml"
    assert_output --partial "Created AGENTS.md"
    assert_output --partial "Next steps:"

    # Verify files were created
    [ -f "vm0.yaml" ]
    [ -f "AGENTS.md" ]

    # Verify basic content
    run cat vm0.yaml
    assert_output --partial "test-agent:"
    assert_output --partial "framework: claude-code"
}

@test "vm0 init --force overwrites existing files" {
    # Create existing files
    echo "old vm0 content" > vm0.yaml
    echo "old agents content" > AGENTS.md

    run $CLI_COMMAND init --name new-agent --force
    assert_success
    assert_output --partial "Created vm0.yaml"
    assert_output --partial "(overwritten)"

    # Verify new content
    run cat vm0.yaml
    assert_output --partial "new-agent:"
}
