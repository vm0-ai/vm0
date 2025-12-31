#!/usr/bin/env bats

# E2E tests for @vm0/runner CLI
# These tests run on AWS Metal instance via SSH using $RUNNER_COMMAND

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Verify RUNNER_COMMAND is set and remote instance is reachable
setup() {
    if [[ -z "$RUNNER_COMMAND" ]]; then
        fail "RUNNER_COMMAND not set - runner was not deployed"
    fi
    ssh_check || fail "Remote instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"
}

@test "vm0-runner --version shows version" {
    run $RUNNER_COMMAND --version
    assert_success
    assert_output --partial "0.1.0"
}

@test "vm0-runner --help shows usage" {
    run $RUNNER_COMMAND --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "vm0-runner"
    assert_output --partial "Self-hosted runner"
}

@test "vm0-runner start fails without runner.yaml" {
    # Ensure no runner.yaml exists
    ssh_run "rm -f ${RUNNER_DIR}/runner.yaml"

    run $RUNNER_COMMAND start
    assert_failure
    assert_output --partial "runner.yaml not found"
}

@test "vm0-runner start --dry-run validates config" {
    # Create test config on remote
    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << 'EOFCONFIG'
name: ci-runner
group: e2e/test
sandbox:
  max_concurrent: 1
  vcpu: 2
  memory_mb: 2048
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"

    run $RUNNER_COMMAND start --dry-run
    assert_success
    assert_output --partial "Config valid"
    assert_output --partial "ci-runner"
    assert_output --partial "e2e/test"

    # Cleanup
    ssh_run "rm -f ${RUNNER_DIR}/runner.yaml"
}

@test "vm0-runner start rejects invalid group format" {
    # Create config with invalid group format
    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << 'EOFCONFIG'
name: ci-runner
group: invalid-no-slash
sandbox:
  max_concurrent: 1
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"

    run $RUNNER_COMMAND start --dry-run
    assert_failure
    assert_output --partial "Invalid configuration"

    # Cleanup
    ssh_run "rm -f ${RUNNER_DIR}/runner.yaml"
}

@test "vm0-runner setup shows placeholder message" {
    run $RUNNER_COMMAND setup
    assert_success
    assert_output --partial "not yet implemented"
}

@test "vm0-runner status shows placeholder message" {
    run $RUNNER_COMMAND status
    assert_success
    assert_output --partial "not yet implemented"
}
