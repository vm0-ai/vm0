#!/usr/bin/env bats

# E2E tests for zero schedule commands - Happy Path Only
#
# These tests verify the complete zero schedule integration works end-to-end.
# Error cases, input variations, and edge cases are tested in:
# - turbo/apps/cli/src/commands/zero/schedule/__tests__/*.test.ts (command-level with MSW)
# - turbo/apps/web/app/api/zero/schedules/**/__tests__/route.test.ts (API routes)
#
# Test Structure:
# - setup_file: Creates shared agent ONCE for all tests, saves state to BATS_FILE_TMPDIR
# - teardown_file: Cleans up agent ONCE after all tests
# - Each @test: Loads state from BATS_FILE_TMPDIR and uses the shared agent

load '../../helpers/setup'

setup_file() {
    local UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    local AGENT_NAME="zero-sched-e2e-${UNIQUE_ID}"
    local TEST_DIR="$(mktemp -d)"

    # Save state to persist across tests (required for BATS parallel execution)
    echo "$UNIQUE_ID" > "$BATS_FILE_TMPDIR/unique_id"
    echo "$AGENT_NAME" > "$BATS_FILE_TMPDIR/agent_name"
    echo "$TEST_DIR" > "$BATS_FILE_TMPDIR/test_dir"

    # Create and compose agent ONCE for all tests
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E zero schedule test agent"
    framework: claude-code
EOF

    cd "$TEST_DIR"
    local COMPOSE_OUTPUT=$($VM0_CLI compose vm0.yaml --json)
    local COMPOSE_ID=$(echo "$COMPOSE_OUTPUT" | jq -r '.composeId')
    echo "$COMPOSE_ID" > "$BATS_FILE_TMPDIR/compose_id"
}

teardown_file() {
    local AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name" 2>/dev/null || true)
    local TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir" 2>/dev/null || true)

    # Clean up schedule and temp directory
    if [ -n "$AGENT_NAME" ]; then
        $ZERO_CLI schedule delete "$AGENT_NAME" --yes 2>/dev/null || true
    fi
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

setup() {
    UNIQUE_ID=$(cat "$BATS_FILE_TMPDIR/unique_id")
    AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name")
    COMPOSE_ID=$(cat "$BATS_FILE_TMPDIR/compose_id")
    TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir")
    cd "$TEST_DIR"
}

# ============================================================
# Happy Path Tests
# ============================================================

@test "t20-1: cron schedule lifecycle (setup, list, status, enable/disable, delete)" {
    # --- Setup (create) ---
    run $ZERO_CLI schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Run scheduled task"
    assert_success
    assert_output --partial "created"
    assert_output --partial "Schedule"

    # --- List ---
    run $ZERO_CLI schedule list
    assert_success
    assert_output --partial "$COMPOSE_ID"
    assert_output --partial "disabled"

    # --- Status ---
    run $ZERO_CLI schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$COMPOSE_ID"
    assert_output --partial "Status:"
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * *"

    # --- Update (setup again) ---
    run $ZERO_CLI schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "10:00" \
        --timezone "America/New_York" \
        --prompt "Updated scheduled task"
    assert_success
    assert_output --partial "updated"

    # Verify update via status
    run $ZERO_CLI schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "0 10 * * *"

    # --- Enable ---
    run $ZERO_CLI schedule enable "$AGENT_NAME"
    assert_success
    assert_output --partial "enabled"

    # Verify enabled in list
    run $ZERO_CLI schedule list
    assert_success
    assert_output --partial "enabled"

    # --- Disable ---
    run $ZERO_CLI schedule disable "$AGENT_NAME"
    assert_success
    assert_output --partial "disabled"

    # --- Delete ---
    run $ZERO_CLI schedule delete "$AGENT_NAME" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "t20-2: loop schedule lifecycle" {
    local LOOP_AGENT_NAME="zero-loop-e2e-${UNIQUE_ID}"
    local LOOP_TEST_DIR="$(mktemp -d)"

    # Create agent for loop schedule
    cat > "$LOOP_TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${LOOP_AGENT_NAME}:
    description: "E2E loop schedule test"
    framework: claude-code
EOF

    cd "$LOOP_TEST_DIR"
    local LOOP_COMPOSE_OUTPUT=$($VM0_CLI compose vm0.yaml --json)
    local LOOP_COMPOSE_ID=$(echo "$LOOP_COMPOSE_OUTPUT" | jq -r '.composeId')

    # --- Setup loop schedule ---
    run $ZERO_CLI schedule setup "$LOOP_AGENT_NAME" \
        --frequency loop \
        --interval 300 \
        --timezone "UTC" \
        --prompt "Loop task every 5 minutes"
    assert_success
    assert_output --partial "created"

    # --- Status ---
    run $ZERO_CLI schedule status "$LOOP_AGENT_NAME"
    assert_success
    assert_output --partial "Loop"
    assert_output --partial "300s"

    # --- List ---
    run $ZERO_CLI schedule list
    assert_success
    assert_output --partial "$LOOP_COMPOSE_ID"

    # --- Enable ---
    run $ZERO_CLI schedule enable "$LOOP_AGENT_NAME"
    assert_success
    assert_output --partial "enabled"

    # --- Disable ---
    run $ZERO_CLI schedule disable "$LOOP_AGENT_NAME"
    assert_success
    assert_output --partial "disabled"

    # --- Delete ---
    run $ZERO_CLI schedule delete "$LOOP_AGENT_NAME" --yes
    assert_success
    assert_output --partial "deleted"

    # Clean up
    rm -rf "$LOOP_TEST_DIR"
}
