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
    assert_output --partial "--method"
}

@test "vm0 onboard -y --method manual creates demo agent directory" {
    run $CLI_COMMAND onboard -y --method manual
    assert_success
    assert_output --partial "Created vm0.yaml"
    assert_output --partial "Created AGENTS.md"
    assert_output --partial "Next steps:"
    assert_output --partial "cd vm0-demo-agent"

    # Verify directory and files were created
    [ -d "vm0-demo-agent" ]
    [ -f "vm0-demo-agent/vm0.yaml" ]
    [ -f "vm0-demo-agent/AGENTS.md" ]

    # Verify basic content
    run cat vm0-demo-agent/vm0.yaml
    assert_output --partial "vm0-demo-agent:"
    assert_output --partial "framework: claude-code"
}

@test "vm0 onboard fails if vm0-demo-agent directory exists" {
    # Create existing directory
    mkdir vm0-demo-agent

    run $CLI_COMMAND onboard -y --method manual
    assert_failure
    assert_output --partial "vm0-demo-agent/ already exists"
}

# =============================================================================
# vm0 setup-claude tests
# =============================================================================

@test "vm0 setup-claude --help shows command description" {
    run $CLI_COMMAND setup-claude --help
    assert_success
    assert_output --partial "Add/update Claude skill for agent building"
}

@test "vm0 setup-claude installs skill from embedded content" {
    run $CLI_COMMAND setup-claude
    assert_success
    assert_output --partial "Installed vm0-agent-builder skill"
    assert_output --partial "Next step:"
    assert_output --partial "/vm0-agent-builder"

    # Verify skill directory was created
    [ -d ".claude/skills/vm0-agent-builder" ]
    [ -f ".claude/skills/vm0-agent-builder/SKILL.md" ]

    # Verify skill content
    run cat .claude/skills/vm0-agent-builder/SKILL.md
    assert_output --partial "name: vm0-agent-builder"
    assert_output --partial "# VM0 Agent Builder"
}

@test "vm0 setup-claude is idempotent (can run multiple times)" {
    # Run first time
    run $CLI_COMMAND setup-claude
    assert_success

    # Run second time - should succeed and overwrite
    run $CLI_COMMAND setup-claude
    assert_success
    assert_output --partial "Installed vm0-agent-builder skill"
}

# =============================================================================
# vm0 onboard --method claude tests
# =============================================================================

@test "vm0 onboard -y --method claude creates demo agent with skill" {
    run $CLI_COMMAND onboard -y --method claude
    assert_success

    # Verify directory structure
    [ -d "vm0-demo-agent" ]
    [ -f "vm0-demo-agent/vm0.yaml" ]
    [ -f "vm0-demo-agent/AGENTS.md" ]

    # Verify skill was installed inside the demo agent
    [ -d "vm0-demo-agent/.claude/skills/vm0-agent-builder" ]
    [ -f "vm0-demo-agent/.claude/skills/vm0-agent-builder/SKILL.md" ]
}
