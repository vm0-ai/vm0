#!/usr/bin/env bats

# Test stdout drain deadline: guest-agent exits cleanly when orphaned child
# processes hold the stdout pipe open after CLI exits.
#
# Uses @orphan-pipe mock-claude mode which spawns a sleep child that inherits
# stdout, then exits.  Without the drain deadline, guest-agent would hang
# indefinitely waiting for EOF.
#
# See: https://github.com/vm0-ai/vm0/issues/8967

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-orphan-pipe-${UNIQUE_ID}"
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "orphan-pipe drain deadline allows agent to exit" {
    if $VM0_CLI auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated"
    fi

    cd "$TEST_DIR"

    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Orphan pipe drain deadline test"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    echo "# Step 1: Compose agent..."
    run $VM0_CLI compose vm0.yaml
    assert_success

    echo "# Step 2: Run with @orphan-pipe prompt..."
    # The mock-claude emits events, spawns a child holding stdout open, then
    # exits.  The drain deadline (5s) should allow guest-agent to break out
    # of the stdout loop and complete the run successfully.
    run $VM0_CLI run "$AGENT_NAME" --no-auto-update "@orphan-pipe"

    echo "# Step 3: Verify run succeeded..."
    assert_success

    # Extract Run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    echo "# Step 4: Verify system logs contain drain deadline message..."
    wait_for_log "$RUN_ID" --system -- "drain deadline"
}
