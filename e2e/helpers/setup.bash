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

# Create a test volume with unique name
# Usage: create_test_volume "prefix"
# Sets: TEST_VOLUME_DIR, VOLUME_NAME
create_test_volume() {
    local prefix="${1:-e2e-vol}"
    export TEST_VOLUME_DIR="$(mktemp -d)"
    export VOLUME_NAME="${prefix}-$(date +%s%3N)-$RANDOM"

    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null
}

# Cleanup test volume directory
cleanup_test_volume() {
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}
