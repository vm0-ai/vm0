#!/usr/bin/env bash

# Get the root directory of the test suite
TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load BATS libraries
load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"

# Path to CLI binaries (trace wrappers log each invocation for timeout debugging)
export VM0_CLI="${TEST_ROOT}/helpers/trace-vm0.sh"
export ZERO_CLI="${TEST_ROOT}/helpers/trace-zero.sh"

# Show system logs when test fails
# This hook is called by BATS before teardown() when a test fails
bats::on_failure() {
    local run_id
    run_id=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | tail -1)
    if [[ -n "$run_id" ]]; then
        echo "# === System logs for failed run ($run_id) ==="
        $VM0_CLI logs "$run_id" --system
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
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null
}

# Retry `vm0 logs --all` until output contains ALL expected strings or timeout.
# Sets $output and $status for subsequent assert_* calls.
# Automatically appends --all to fetch complete logs on each attempt.
# Usage: wait_for_log [vm0 logs args...] -- <expected1> [expected2...]
# Example: wait_for_log "$RUN_ID" --system -- "Tool timeout" "WebFetch"
# Example: wait_for_log "$RUN_ID" --network -- "TCP" ":22" ":443"
wait_for_log() {
    local -a _wfl_args=()
    local -a _wfl_expected=()
    local _wfl_sep_found=false
    for arg in "$@"; do
        if [[ "$arg" == "--" ]]; then
            _wfl_sep_found=true
        elif $_wfl_sep_found; then
            _wfl_expected+=("$arg")
        else
            _wfl_args+=("$arg")
        fi
    done
    if [[ ${#_wfl_expected[@]} -eq 0 ]]; then
        echo "# wait_for_log: no expected strings after --"
        return 1
    fi
    local _wfl_timeout=30
    local _wfl_elapsed=0
    while (( _wfl_elapsed < _wfl_timeout )); do
        # Append --all for non-search commands to fetch complete logs
        if [[ "${_wfl_args[0]:-}" == "search" ]]; then
            output="$($VM0_CLI logs "${_wfl_args[@]}" 2>&1)"
        else
            output="$($VM0_CLI logs "${_wfl_args[@]}" --all 2>&1)"
        fi
        status=$?
        if [[ "$status" -eq 0 ]]; then
            local _wfl_all=true
            for _wfl_e in "${_wfl_expected[@]}"; do
                if [[ "$output" != *"$_wfl_e"* ]]; then
                    _wfl_all=false
                    break
                fi
            done
            if $_wfl_all; then
                return 0
            fi
        fi
        sleep 2
        (( _wfl_elapsed += 2 ))
    done
    echo "# Timed out (${_wfl_timeout}s) waiting for log containing: ${_wfl_expected[*]}"
    echo "# Last output: $output"
    return 1
}

# Cleanup test volume directory
cleanup_test_volume() {
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}
