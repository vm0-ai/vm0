#!/usr/bin/env bats

# Test cancellation of a running job through the run API.
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

@test "run API cancels a running job" {
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
    run seed_compose_fixture vm0.yaml
    assert_success

    echo "# Step 2: Create a long-running fixture..."
    run create_compose_run_fixture "$AGENT_NAME" "sleep 300"
    assert_success
    RUN_ID=$(jq -er '.runId' <<< "$output")
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        echo "$output"
        return 1
    }
    echo "# Got Run ID: $RUN_ID"

    echo "# Step 4: Kill the run..."
    run cancel_run_fixture "$RUN_ID"
    assert_success
    assert_output --partial "cancelled"

    echo "# Step 5: Verify terminal cancellation state..."
    run wait_for_run_fixture "$RUN_ID" 60
    assert_failure
    assert_output --partial '"status":"cancelled"'
}
