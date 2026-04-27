#!/usr/bin/env bats

# Test stuck-tool watchdog: guest-agent kills CLI when WebFetch hangs.
# Uses @stuck-tool mock-claude mode + short timeout (3s) for fast testing.
#
# Workaround for Claude Code bug:
# https://github.com/anthropics/claude-code/issues/11650

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-stuck-tool-${UNIQUE_ID}"
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "stuck-tool watchdog kills agent when WebFetch hangs" {
    if $VM0_CLI auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated"
    fi

    cd "$TEST_DIR"

    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Stuck tool watchdog test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      VM0_STUCK_TOOL_TIMEOUT_SECS: "3"
EOF

    echo "# Step 1: Compose agent..."
    run $VM0_CLI compose vm0.yaml
    assert_success

    echo "# Step 2: Run with @stuck-tool prompt and 3s timeout..."
    # VM0_STUCK_TOOL_TIMEOUT_SECS=3 makes the watchdog trigger in ~3-8s
    # instead of 60s, keeping the test fast.
    run $VM0_CLI run "$AGENT_NAME" --no-auto-update "@stuck-tool"

    echo "# Step 3: Verify run failed..."
    assert_failure
    assert_output --partial "Run failed"

    # The public CLI output intentionally hides internal execution details as
    # a reportable unexpected error, so verify the watchdog in system logs.
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    echo "# Step 4: Verify system logs contain tool timeout error..."
    local log_output=""
    local log_status=1
    local found=false
    for _ in {1..15}; do
        log_output="$($VM0_CLI logs "$RUN_ID" --system 2>&1)"
        log_status=$?
        if [[ "$log_status" -eq 0 && "$log_output" == *"Tool timeout"* && "$log_output" == *"WebFetch"* ]]; then
            found=true
            break
        fi
        sleep 2
    done

    if [[ "$found" != "true" ]]; then
        echo "# Timed out waiting for system log containing: Tool timeout WebFetch"
        echo "# Last output: $log_output"
        return 1
    fi
}
