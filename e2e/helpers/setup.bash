#!/usr/bin/env bash

# Get the root directory of the test suite
TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load BATS libraries
load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"

# Path to the CLI
export CLI_COMMAND="vm0"

# Show system logs when test fails
# This hook is called by BATS before teardown() when a test fails
bats::on_failure() {
    local run_id
    run_id=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | tail -1)
    if [[ -n "$run_id" ]]; then
        echo "# === System logs for failed run ($run_id) ==="
        $CLI_COMMAND logs "$run_id" --system
    fi
}
