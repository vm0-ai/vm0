#!/usr/bin/env bats

# Test run cancellation: vm0 run kill cancels a running job via Ably.
# Uses "sleep 300" as prompt — mock-claude executes it as bash, keeping
# the run alive long enough to cancel.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-cancel-${UNIQUE_ID}"
}

teardown() {
    # Kill background run process if still alive
    if [ -n "$RUN_PID" ] && kill -0 "$RUN_PID" 2>/dev/null; then
        kill "$RUN_PID" 2>/dev/null || true
        wait "$RUN_PID" 2>/dev/null || true
    fi
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "vm0 run kill cancels a running job" {
    if $VM0_CLI auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated"
    fi

    cd "$TEST_DIR"

    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Cancel test agent"
    framework: claude-code
EOF

    echo "# Step 1: Compose agent..."
    run $VM0_CLI compose vm0.yaml
    assert_success

    echo "# Step 2: Start run in background (sleep 300 keeps it alive)..."
    $VM0_CLI run "$AGENT_NAME" --no-auto-update "sleep 300" > "$TEST_DIR/run_output.txt" 2>&1 &
    RUN_PID=$!

    echo "# Step 3: Extract Run ID from output..."
    RUN_ID=""
    for i in $(seq 1 30); do
        RUN_ID=$(grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' "$TEST_DIR/run_output.txt" 2>/dev/null | head -1)
        [ -n "$RUN_ID" ] && break
        sleep 1
    done
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        cat "$TEST_DIR/run_output.txt" 2>/dev/null
        return 1
    }
    echo "# Got Run ID: $RUN_ID"

    echo "# Step 4: Kill the run..."
    run $VM0_CLI run kill "$RUN_ID"
    assert_success
    assert_output --partial "cancelled"

    echo "# Step 5: Wait for background run to exit..."
    for i in $(seq 1 60); do
        kill -0 "$RUN_PID" 2>/dev/null || break
        sleep 1
    done
    if kill -0 "$RUN_PID" 2>/dev/null; then
        kill "$RUN_PID" 2>/dev/null || true
        echo "# Background run did not exit after 60s"
        return 1
    fi

    echo "# Step 6: Verify output shows cancellation..."
    cat "$TEST_DIR/run_output.txt" | grep -qi "cancel" || {
        echo "# Expected 'cancel' in output but got:"
        cat "$TEST_DIR/run_output.txt"
        return 1
    }
}
