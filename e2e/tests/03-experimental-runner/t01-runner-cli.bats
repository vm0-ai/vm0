#!/usr/bin/env bats

# E2E tests for @vm0/runner CLI
# These tests run on AWS Metal instance via SSH

load '../../helpers/setup.bash'
load '../../helpers/metal.bash'

# Verify Metal instance is reachable before each test
setup() {
    metal_check || fail "Metal instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"
}

@test "vm0-runner --version shows version" {
    run metal_run "cd /opt/vm0-runner && node index.js --version"
    assert_success
    assert_output --partial "0.1.0"
}

@test "vm0-runner --help shows usage" {
    run metal_run "cd /opt/vm0-runner && node index.js --help"
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "vm0-runner"
    assert_output --partial "Self-hosted runner"
}

@test "vm0-runner start fails without runner.yaml" {
    run metal_run "cd /tmp && node /opt/vm0-runner/index.js start"
    assert_failure
    assert_output --partial "runner.yaml not found"
}

@test "vm0-runner start --dry-run validates config" {
    # Create test config on Metal
    metal_run "cat > /opt/vm0-runner/runner.yaml << 'EOFCONFIG'
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

    run metal_run "cd /opt/vm0-runner && node index.js start --dry-run"
    assert_success
    assert_output --partial "Config valid"
    assert_output --partial "ci-runner"
    assert_output --partial "e2e/test"

    # Cleanup
    metal_run "rm -f /opt/vm0-runner/runner.yaml"
}

@test "vm0-runner start rejects invalid group format" {
    # Create config with invalid group format
    metal_run "cat > /opt/vm0-runner/runner.yaml << 'EOFCONFIG'
name: ci-runner
group: invalid-no-slash
sandbox:
  max_concurrent: 1
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"

    run metal_run "cd /opt/vm0-runner && node index.js start --dry-run"
    assert_failure
    assert_output --partial "Invalid configuration"

    # Cleanup
    metal_run "rm -f /opt/vm0-runner/runner.yaml"
}

@test "vm0-runner setup shows placeholder message" {
    run metal_run "cd /opt/vm0-runner && node index.js setup"
    assert_success
    assert_output --partial "not yet implemented"
}

@test "vm0-runner status shows placeholder message" {
    run metal_run "cd /opt/vm0-runner && node index.js status"
    assert_success
    assert_output --partial "not yet implemented"
}
