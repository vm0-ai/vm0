#!/usr/bin/env bats

# E2E tests for @vm0/runner CLI
# These tests run on AWS Metal instance via SSH

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Helper to run vm0-runner commands on remote
runner_cmd() {
    ssh_run "cd ${RUNNER_DIR} && node index.js $*"
}

# Verify RUNNER_DIR is set and remote instance is reachable
setup() {
    if [[ -z "$RUNNER_DIR" ]]; then
        fail "RUNNER_DIR not set - runner was not deployed"
    fi
    ssh_check || fail "Remote instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"
}

@test "vm0-runner --version shows version" {
    run runner_cmd --version
    assert_success
    # Check for semantic version pattern (e.g., 0.1.0, 1.0.0)
    [[ "$output" =~ [0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "vm0-runner --help shows usage" {
    run runner_cmd --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "vm0-runner"
    assert_output --partial "Self-hosted runner"
}

@test "vm0-runner start fails without runner.yaml" {
    # Backup existing runner.yaml if exists (created by CI workflow)
    ssh_run "mv ${RUNNER_DIR}/runner.yaml ${RUNNER_DIR}/runner.yaml.bak 2>/dev/null || true"

    run runner_cmd start
    assert_failure
    assert_output --partial "runner.yaml not found"

    # Restore runner.yaml
    ssh_run "mv ${RUNNER_DIR}/runner.yaml.bak ${RUNNER_DIR}/runner.yaml 2>/dev/null || true"
}

@test "vm0-runner start rejects invalid group format" {
    # Backup existing runner.yaml
    ssh_run "mv ${RUNNER_DIR}/runner.yaml ${RUNNER_DIR}/runner.yaml.bak 2>/dev/null || true"

    # Create config with invalid group format
    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << 'EOFCONFIG'
name: ci-runner
group: invalid-no-slash
server:
  url: https://example.com
  token: test-token
sandbox:
  max_concurrent: 1
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"

    run runner_cmd start
    assert_failure
    assert_output --partial "Invalid configuration"

    # Restore runner.yaml
    ssh_run "mv ${RUNNER_DIR}/runner.yaml.bak ${RUNNER_DIR}/runner.yaml 2>/dev/null || true"
}

@test "vm0-runner status shows placeholder message" {
    run runner_cmd status
    assert_success
    assert_output --partial "not yet implemented"
}
