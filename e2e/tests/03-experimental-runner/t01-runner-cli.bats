#!/usr/bin/env bats

# E2E tests for @vm0/runner CLI
# These tests run on AWS Metal instance via SSH
#
# IMPORTANT: These tests use a separate "smoke" directory to avoid interfering
# with the actual runner that CI workflow started. This prevents race conditions
# with other parallel tests that depend on the running runner.

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Smoke test directory - separate from the running CI runner
SMOKE_DIR=""

# Helper to run vm0-runner commands in smoke directory
runner_cmd() {
    ssh_run "cd ${SMOKE_DIR} && node index.js $*"
}

# Verify RUNNER_DIR is set and remote instance is reachable
setup() {
    if [[ -z "$RUNNER_DIR" ]]; then
        fail "RUNNER_DIR not set - runner was not deployed"
    fi
    ssh_check || fail "Remote instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"

    # Create smoke test directory (copy runner binary but not config)
    SMOKE_DIR="${RUNNER_DIR}/smoke"
    ssh_run "mkdir -p ${SMOKE_DIR}"
    ssh_run "cp ${RUNNER_DIR}/index.js ${SMOKE_DIR}/ 2>/dev/null || true"
    ssh_run "cp ${RUNNER_DIR}/package.json ${SMOKE_DIR}/ 2>/dev/null || true"
    ssh_run "cp -r ${RUNNER_DIR}/node_modules ${SMOKE_DIR}/ 2>/dev/null || true"
}

teardown() {
    # Clean up smoke test config files (keep directory for other tests)
    if [[ -n "$SMOKE_DIR" ]]; then
        ssh_run "rm -f ${SMOKE_DIR}/runner.yaml 2>/dev/null || true"
    fi
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
    # Smoke directory has no runner.yaml by default
    run runner_cmd start
    assert_failure
    assert_output --partial "runner.yaml not found"
}

@test "vm0-runner start rejects invalid group format" {
    # Create config with invalid group format in smoke directory
    ssh_run "cat > ${SMOKE_DIR}/runner.yaml << 'EOFCONFIG'
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
}

@test "vm0-runner status shows placeholder message" {
    run runner_cmd status
    assert_success
    assert_output --partial "not yet implemented"
}
