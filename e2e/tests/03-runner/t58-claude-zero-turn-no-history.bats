#!/usr/bin/env bats

# Regression test for Claude Code runs that exit 0 with num_turns=0 but never
# create a session history file.
#
# Real zero-turn slash-command flows can produce this shape. The runner should
# surface a structured finalization error instead of failing later with a
# checkpoint read error.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-zero-turn-no-history-${UNIQUE_ID}"
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "claude zero-turn no-history run fails with structured finalization error" {
    if $VM0_CLI auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated"
    fi

    cd "$TEST_DIR"

    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Claude zero-turn no-history regression test"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    echo "# Step 1: Compose agent..."
    run $VM0_CLI compose vm0.yaml
    assert_success

    echo "# Step 2: Run with @zero-turn-no-history prompt..."
    run $VM0_CLI run "$AGENT_NAME" --no-auto-update "@zero-turn-no-history"

    echo "# Step 3: Verify run failed with the structured no-history error..."
    assert_failure
    assert_output --partial "Run failed"
    assert_output --partial "Claude Code emitted a zero-turn result without creating session history"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    echo "# Step 4: Verify system logs skip recovery checkpoint cleanly..."
    wait_for_log "$RUN_ID" --system -- \
        "Claude Code emitted a zero-turn result without creating session history" \
        "Skipping recovery checkpoint because no session history was created"

    refute_output --partial "Checkpoint failed:"
    refute_output --partial "Failed to read session history"
    refute_output --partial "Attempting best-effort recovery checkpoint"
}
