#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 init command tests

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

@test "vm0 init creates vm0.yaml and AGENTS.md with agent name via stdin" {
    # Provide agent name via stdin using echo pipe
    run bash -c 'echo "test-agent" | '"$CLI_COMMAND"' init'
    assert_success
    assert_output --partial "Created vm0.yaml"
    assert_output --partial "Created AGENTS.md"
    assert_output --partial "Next steps:"

    # Verify files were created
    [ -f "vm0.yaml" ]
    [ -f "AGENTS.md" ]
}

@test "vm0 init generates correct vm0.yaml content" {
    run bash -c 'echo "my-agent" | '"$CLI_COMMAND"' init'
    assert_success

    # Verify vm0.yaml content
    run cat vm0.yaml
    assert_output --partial 'version: "1.0"'
    assert_output --partial "my-agent:"
    assert_output --partial "provider: claude-code"
    assert_output --partial "instructions: AGENTS.md"
    assert_output --partial "CLAUDE_CODE_OAUTH_TOKEN"
    assert_output --partial "# Build agentic workflow"
}

@test "vm0 init generates correct AGENTS.md content" {
    run bash -c 'echo "my-agent" | '"$CLI_COMMAND"' init'
    assert_success

    # Verify AGENTS.md content
    run cat AGENTS.md
    assert_output --partial "Agent Instructions"
    assert_output --partial "HackerNews"
    assert_output --partial "Workflow"
}

@test "vm0 init fails when vm0.yaml already exists" {
    # Create existing vm0.yaml
    echo "existing content" > vm0.yaml

    run bash -c 'echo "test-agent" | '"$CLI_COMMAND"' init'
    assert_failure
    assert_output --partial "vm0.yaml already exists"
    assert_output --partial "vm0 init --force"
}

@test "vm0 init fails when AGENTS.md already exists" {
    # Create existing AGENTS.md
    echo "existing content" > AGENTS.md

    run bash -c 'echo "test-agent" | '"$CLI_COMMAND"' init'
    assert_failure
    assert_output --partial "AGENTS.md already exists"
    assert_output --partial "vm0 init --force"
}

@test "vm0 init --force overwrites existing files" {
    # Create existing files
    echo "old vm0 content" > vm0.yaml
    echo "old agents content" > AGENTS.md

    run bash -c 'echo "new-agent" | '"$CLI_COMMAND"' init --force'
    assert_success
    assert_output --partial "Created vm0.yaml"
    assert_output --partial "(overwritten)"

    # Verify new content
    run cat vm0.yaml
    assert_output --partial "new-agent:"
}

@test "vm0 init -f short option works" {
    # Create existing files
    echo "old content" > vm0.yaml
    echo "old content" > AGENTS.md

    run bash -c 'echo "short-flag-agent" | '"$CLI_COMMAND"' init -f'
    assert_success
    assert_output --partial "Created vm0.yaml"
}

@test "vm0 init rejects invalid agent name (too short)" {
    run bash -c 'echo "ab" | '"$CLI_COMMAND"' init'
    assert_failure
    assert_output --partial "Invalid agent name"
}

@test "vm0 init rejects empty agent name" {
    run bash -c 'echo "" | '"$CLI_COMMAND"' init'
    assert_failure
    assert_output --partial "Invalid agent name"
}

@test "vm0 init --name creates files without interactive prompt" {
    run $CLI_COMMAND init --name cli-agent
    assert_success
    assert_output --partial "Created vm0.yaml"
    assert_output --partial "Created AGENTS.md"

    # Verify file content
    run cat vm0.yaml
    assert_output --partial "cli-agent:"
}

@test "vm0 init -n short option works" {
    run $CLI_COMMAND init -n short-name-agent
    assert_success
    assert_output --partial "Created vm0.yaml"

    run cat vm0.yaml
    assert_output --partial "short-name-agent:"
}

@test "vm0 init --name with --force overwrites existing files" {
    # Create existing files
    echo "old content" > vm0.yaml
    echo "old content" > AGENTS.md

    run $CLI_COMMAND init --name new-cli-agent --force
    assert_success
    assert_output --partial "(overwritten)"

    run cat vm0.yaml
    assert_output --partial "new-cli-agent:"
}

@test "vm0 init --name rejects invalid agent name" {
    run $CLI_COMMAND init --name ab
    assert_failure
    assert_output --partial "Invalid agent name"
}
