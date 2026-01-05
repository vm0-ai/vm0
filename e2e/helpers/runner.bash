#!/usr/bin/env bash

# Helper functions for runner E2E tests
# These helpers reduce SSH overhead by only fetching logs when needed

# Get runner logs from AWS Metal server
# This has SSH overhead, use sparingly
get_runner_logs() {
    local pr_num="${PR_NUMBER:-unknown}"
    ssh_run "cat /tmp/vm0-runner-pr-${pr_num}.log 2>/dev/null || echo 'No logs'"
}

# Show runner logs only on failure (when $status != 0)
# Usage: run some_command; show_logs_on_failure
show_logs_on_failure() {
    if [[ $status -ne 0 ]]; then
        echo "# Command failed with status $status, fetching runner logs..."
        get_runner_logs
    fi
}

# Assert success and show logs on failure
# Usage: run some_command; assert_success_with_logs
assert_success_with_logs() {
    if [[ $status -ne 0 ]]; then
        echo "# Command failed with status $status"
        echo "# Runner logs (for debugging):"
        get_runner_logs
    fi
    assert_success
}
