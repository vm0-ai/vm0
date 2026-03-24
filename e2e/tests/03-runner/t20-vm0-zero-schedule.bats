#!/usr/bin/env bats

# E2E tests for vm0 zero schedule commands - Happy Path Only
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
    working_dir: /home/user/workspace
EOF

    cd "$TEST_DIR"
    local COMPOSE_OUTPUT=$($CLI_COMMAND compose vm0.yaml --json)
    local COMPOSE_ID=$(echo "$COMPOSE_OUTPUT" | jq -r '.composeId')
    echo "$COMPOSE_ID" > "$BATS_FILE_TMPDIR/compose_id"
}

teardown_file() {
    local AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name" 2>/dev/null || true)
    local TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir" 2>/dev/null || true)

    # Clean up schedule and temp directory
    if [ -n "$AGENT_NAME" ]; then
        $CLI_COMMAND zero schedule delete "$AGENT_NAME" --yes 2>/dev/null || true
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
    run $CLI_COMMAND zero schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Run scheduled task"
    assert_success
    assert_output --partial "Created schedule"
    assert_output --partial "$AGENT_NAME"

    # --- List ---
    run $CLI_COMMAND zero schedule list
    assert_success
    assert_output --partial "$COMPOSE_ID"
    assert_output --partial "disabled"

    # --- Status ---
    run $CLI_COMMAND zero schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$COMPOSE_ID"
    assert_output --partial "Status:"
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * *"

    # --- Update (setup again) ---
    run $CLI_COMMAND zero schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "10:00" \
        --timezone "America/New_York" \
        --prompt "Updated scheduled task"
    assert_success
    assert_output --partial "Updated schedule"

    # Verify update via status
    run $CLI_COMMAND zero schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "0 10 * * *"

    # --- Enable ---
    run $CLI_COMMAND zero schedule enable "$AGENT_NAME"
    assert_success
    assert_output --partial "Enabled"

    # Verify enabled in list
    run $CLI_COMMAND zero schedule list
    assert_success
    assert_output --partial "enabled"

    # --- Disable ---
    run $CLI_COMMAND zero schedule disable "$AGENT_NAME"
    assert_success
    assert_output --partial "Disabled"

    # --- Delete ---
    run $CLI_COMMAND zero schedule delete "$AGENT_NAME" --yes
    assert_success
    assert_output --partial "Deleted"
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
    working_dir: /home/user/workspace
EOF

    cd "$LOOP_TEST_DIR"
    local LOOP_COMPOSE_OUTPUT=$($CLI_COMMAND compose vm0.yaml --json)
    local LOOP_COMPOSE_ID=$(echo "$LOOP_COMPOSE_OUTPUT" | jq -r '.composeId')

    # --- Setup loop schedule ---
    run $CLI_COMMAND zero schedule setup "$LOOP_AGENT_NAME" \
        --frequency loop \
        --interval 300 \
        --timezone "UTC" \
        --prompt "Loop task every 5 minutes"
    assert_success
    assert_output --partial "Created schedule"

    # --- Status ---
    run $CLI_COMMAND zero schedule status "$LOOP_AGENT_NAME"
    assert_success
    assert_output --partial "Loop"
    assert_output --partial "300s"

    # --- List ---
    run $CLI_COMMAND zero schedule list
    assert_success
    assert_output --partial "$LOOP_COMPOSE_ID"

    # --- Enable ---
    run $CLI_COMMAND zero schedule enable "$LOOP_AGENT_NAME"
    assert_success
    assert_output --partial "Enabled"

    # --- Disable ---
    run $CLI_COMMAND zero schedule disable "$LOOP_AGENT_NAME"
    assert_success
    assert_output --partial "Disabled"

    # --- Delete ---
    run $CLI_COMMAND zero schedule delete "$LOOP_AGENT_NAME" --yes
    assert_success
    assert_output --partial "Deleted"

    # Clean up
    rm -rf "$LOOP_TEST_DIR"
}
