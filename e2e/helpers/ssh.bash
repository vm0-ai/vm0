#!/usr/bin/env bash

# Helper for running commands on remote instance via SSH
# Requires environment variables:
#   CI_AWS_METAL_RUNNER_USER - SSH username
#   CI_AWS_METAL_RUNNER_HOST - Remote instance IP/hostname
# Optional:
#   SSH_KEY_PATH - Path to SSH private key (for CI)

ssh_run() {
    if [[ -z "$CI_AWS_METAL_RUNNER_USER" || -z "$CI_AWS_METAL_RUNNER_HOST" ]]; then
        echo "Error: CI_AWS_METAL_RUNNER_USER and CI_AWS_METAL_RUNNER_HOST must be set" >&2
        return 1
    fi

    local ssh_opts=(-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10)

    # Add SSH key if specified
    if [[ -n "$SSH_KEY_PATH" ]]; then
        ssh_opts+=(-i "$SSH_KEY_PATH")
    fi

    ssh "${ssh_opts[@]}" \
        "$CI_AWS_METAL_RUNNER_USER@$CI_AWS_METAL_RUNNER_HOST" \
        "$@"
}

# Check if remote instance is reachable
ssh_check() {
    ssh_run "echo 'Remote instance reachable'" >/dev/null 2>&1
}
