#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 setup-github command tests
# NOTE: These tests assume VM0 is authenticated (done in CI setup)

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

# Helper to check if GitHub CLI is installed
check_gh_installed() {
    command -v gh >/dev/null 2>&1
}

# Helper to check if VM0 is authenticated
check_vm0_auth() {
    $CLI_COMMAND auth status 2>/dev/null | grep -q "Authenticated"
}

# Combined helper for tests that need both gh and VM0 auth
check_setup_github_prereqs() {
    check_gh_installed && check_vm0_auth
}

@test "vm0 setup-github --help shows command description" {
    run $CLI_COMMAND setup-github --help
    assert_success
    assert_output --partial "Initialize GitHub Actions workflows"
    assert_output --partial "--force"
    assert_output --partial "--yes"
    assert_output --partial "--skip-secrets"
}

@test "vm0 setup-github checks prerequisites in order" {
    check_gh_installed || skip "GitHub CLI (gh) not installed"

    # Without vm0.yaml, the command should fail at some prerequisite check
    run $CLI_COMMAND setup-github --skip-secrets
    assert_failure
    # Should show prerequisite checking message
    assert_output --partial "Checking prerequisites"
}

@test "vm0 setup-github creates workflow files with --skip-secrets" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init

    # First create a vm0.yaml
    $CLI_COMMAND init --name test-setup-agent

    # Run setup-github with --skip-secrets to avoid gh secret operations
    run $CLI_COMMAND setup-github --skip-secrets
    assert_success
    assert_output --partial "Created .github/workflows/publish.yml"
    assert_output --partial "Created .github/workflows/run.yml"
    assert_output --partial "Done (secrets setup skipped)"

    # Verify workflow files were created
    [ -f ".github/workflows/publish.yml" ]
    [ -f ".github/workflows/run.yml" ]
}

@test "vm0 setup-github generates correct publish.yml content" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name my-publish-agent

    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify publish.yml content
    run cat .github/workflows/publish.yml
    assert_output --partial "name: Publish Agent"
    assert_output --partial "branches: [main]"
    assert_output --partial "vm0.yaml"
    assert_output --partial "AGENTS.md"
    assert_output --partial "vm0-ai/compose-action@v1"
    assert_output --partial "secrets.VM0_TOKEN"
}

@test "vm0 setup-github generates correct run.yml content with agent name" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name my-run-agent

    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify run.yml content
    run cat .github/workflows/run.yml
    assert_output --partial "name: Run Agent"
    assert_output --partial "workflow_dispatch:"
    assert_output --partial "agent: my-run-agent"
    assert_output --partial "vm0-ai/run-action@v1"
    assert_output --partial "secrets.VM0_TOKEN"
}

@test "vm0 setup-github warns about existing workflow files" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name test-agent

    # Create existing workflow file
    mkdir -p .github/workflows
    echo "existing content" > .github/workflows/publish.yml

    # Run without --force, answer 'n' to overwrite prompt
    run bash -c 'echo "n" | '"$CLI_COMMAND"' setup-github --skip-secrets'
    assert_success  # exits with 0 when user declines
    assert_output --partial "Existing workflow files detected"
    assert_output --partial "vm0 setup-github --force"
}

@test "vm0 setup-github --force overwrites existing workflow files" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name test-agent

    # Create existing workflow files
    mkdir -p .github/workflows
    echo "old publish content" > .github/workflows/publish.yml
    echo "old run content" > .github/workflows/run.yml

    run $CLI_COMMAND setup-github --force --skip-secrets
    assert_success
    assert_output --partial "Overwrote .github/workflows/publish.yml"
    assert_output --partial "Overwrote .github/workflows/run.yml"

    # Verify new content
    run cat .github/workflows/publish.yml
    assert_output --partial "name: Publish Agent"
}

@test "vm0 setup-github -f short option works" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name test-agent

    # Create existing workflow file
    mkdir -p .github/workflows
    echo "old content" > .github/workflows/publish.yml

    run $CLI_COMMAND setup-github -f --skip-secrets
    assert_success
    assert_output --partial "Overwrote"
}

@test "vm0 setup-github includes secrets from experimental_secrets" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init

    # Create vm0.yaml with experimental_secrets
    cat > vm0.yaml << 'EOF'
version: "1.0"
agents:
  secret-test-agent:
    provider: claude-code
    instructions: AGENTS.md
    experimental_secrets:
      - CUSTOM_API_KEY
      - ANOTHER_SECRET
EOF
    echo "# Agent Instructions" > AGENTS.md

    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify run.yml includes the secrets
    run cat .github/workflows/run.yml
    assert_output --partial "CUSTOM_API_KEY=\${{ secrets.CUSTOM_API_KEY }}"
    assert_output --partial "ANOTHER_SECRET=\${{ secrets.ANOTHER_SECRET }}"
}

@test "vm0 setup-github includes vars from experimental_vars" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init

    # Create vm0.yaml with experimental_vars
    cat > vm0.yaml << 'EOF'
version: "1.0"
agents:
  vars-test-agent:
    provider: claude-code
    instructions: AGENTS.md
    experimental_vars:
      - REGION
      - ENVIRONMENT
EOF
    echo "# Agent Instructions" > AGENTS.md

    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify run.yml includes the vars
    run cat .github/workflows/run.yml
    assert_output --partial "REGION=\${{ vars.REGION }}"
    assert_output --partial "ENVIRONMENT=\${{ vars.ENVIRONMENT }}"
}

@test "vm0 setup-github --yes auto-confirms overwrite prompt" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name test-agent

    # Create existing workflow file
    mkdir -p .github/workflows
    echo "old content" > .github/workflows/publish.yml

    # --yes should auto-confirm without prompting
    run $CLI_COMMAND setup-github --yes --skip-secrets
    assert_success
    assert_output --partial "Overwrote .github/workflows/publish.yml"
}

@test "vm0 setup-github -y short option works" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init

    $CLI_COMMAND init --name test-agent

    mkdir -p .github/workflows
    echo "old content" > .github/workflows/publish.yml

    run $CLI_COMMAND setup-github -y --skip-secrets
    assert_success
    assert_output --partial "Overwrote"
}

@test "vm0 setup-github from subdirectory writes workflows to git root" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    # Initialize git repo at root
    git init

    # Create subdirectory with vm0 config
    mkdir .vm0
    cd .vm0
    $CLI_COMMAND init --name subdir-test-agent

    # Run setup-github from subdirectory
    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify workflow files at git root (parent directory)
    [ -f "../.github/workflows/publish.yml" ]
    [ -f "../.github/workflows/run.yml" ]

    # Verify working-directory in publish.yml
    run cat ../.github/workflows/publish.yml
    assert_output --partial "working-directory: .vm0"
    assert_output --partial "'.vm0/vm0.yaml'"
    assert_output --partial "'.vm0/AGENTS.md'"
}

@test "vm0 setup-github from nested subdirectory uses correct working-directory" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init

    # Create nested subdirectory
    mkdir -p configs/agents
    cd configs/agents
    $CLI_COMMAND init --name nested-test-agent

    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify workflow files at git root
    [ -f "../../.github/workflows/publish.yml" ]

    # Verify correct nested working-directory
    run cat ../../.github/workflows/publish.yml
    assert_output --partial "working-directory: configs/agents"
    assert_output --partial "'configs/agents/vm0.yaml'"
}

@test "vm0 setup-github fails when not in git repository" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    # Don't initialize git - just create vm0.yaml
    $CLI_COMMAND init --name no-git-agent

    run $CLI_COMMAND setup-github --skip-secrets
    assert_failure
    assert_output --partial "Not in a git repository"
}

@test "vm0 setup-github from git root does not include working-directory" {
    check_setup_github_prereqs || skip "Requires gh CLI and VM0 auth"

    git init
    $CLI_COMMAND init --name root-agent

    run $CLI_COMMAND setup-github --skip-secrets
    assert_success

    # Verify publish.yml does NOT contain working-directory
    run cat .github/workflows/publish.yml
    refute_output --partial "working-directory"

    # Verify paths are not prefixed
    assert_output --partial "'vm0.yaml'"
    assert_output --partial "'AGENTS.md'"
}
