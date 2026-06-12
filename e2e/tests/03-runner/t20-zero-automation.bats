#!/usr/bin/env bats

# E2E tests for zero automation commands - Happy Path Only
#
# These tests verify the complete zero automation integration works end-to-end.
# Error cases, input variations, and edge cases are tested in:
# - turbo/apps/cli/src/commands/zero/automation/__tests__/*.test.ts (command-level with MSW)
# - turbo/apps/api/src/signals/routes/__tests__/automations-v2.test.ts (API routes)
#
# Test Structure:
# - setup_file: Creates shared agent ONCE for all tests, saves state to BATS_FILE_TMPDIR
# - teardown_file: Cleans up agent ONCE after all tests
# - Each @test: Loads state from BATS_FILE_TMPDIR and uses the shared agent

load '../../helpers/setup'

setup_file() {
    local UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    local AGENT_NAME="zero-auto-e2e-${UNIQUE_ID}"
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
    description: "E2E zero automation test agent"
    framework: claude-code
EOF

    cd "$TEST_DIR"
    local COMPOSE_OUTPUT=$($VM0_CLI compose vm0.yaml --json)
    local COMPOSE_ID=$(echo "$COMPOSE_OUTPUT" | jq -r '.composeId')
    echo "$COMPOSE_ID" > "$BATS_FILE_TMPDIR/compose_id"
}

teardown_file() {
    local UNIQUE_ID=$(cat "$BATS_FILE_TMPDIR/unique_id" 2>/dev/null || true)
    local TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir" 2>/dev/null || true)

    # Clean up automations and temp directory
    if [ -n "$UNIQUE_ID" ]; then
        $ZERO_CLI automation delete "cron-auto-${UNIQUE_ID}" --yes 2>/dev/null || true
        $ZERO_CLI automation delete "loop-auto-${UNIQUE_ID}" --yes 2>/dev/null || true
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

@test "t20-1: cron automation lifecycle (create, list, show, update, enable/disable, delete)" {
    local AUTOMATION_NAME="cron-auto-${UNIQUE_ID}"

    # --- Create with a cron trigger ---
    run $ZERO_CLI automation create \
        -n "$AUTOMATION_NAME" \
        --agent "$COMPOSE_ID" \
        -p "Run scheduled task" \
        --cron "0 9 * * *" \
        -z "UTC"
    assert_success
    assert_output --partial "created"
    assert_output --partial "$AUTOMATION_NAME"

    # --- List ---
    run $ZERO_CLI automation list
    assert_success
    assert_output --partial "$AUTOMATION_NAME"
    assert_output --partial "enabled"

    # --- Show ---
    run $ZERO_CLI automation show "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "Name:"
    assert_output --partial "Agent:"
    assert_output --partial "Status:"
    assert_output --partial "0 9 * * *"

    # --- Update the instruction ---
    run $ZERO_CLI automation update "$AUTOMATION_NAME" \
        -p "Updated scheduled task"
    assert_success
    assert_output --partial "updated"

    # Verify update via show
    run $ZERO_CLI automation show "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "Updated scheduled task"

    # --- Disable ---
    run $ZERO_CLI automation disable "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "disabled"

    # Verify disabled in list
    run $ZERO_CLI automation list
    assert_success
    assert_output --partial "disabled"

    # --- Enable ---
    run $ZERO_CLI automation enable "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "enabled"

    # --- Delete ---
    run $ZERO_CLI automation delete "$AUTOMATION_NAME" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "t20-2: loop automation lifecycle" {
    local AUTOMATION_NAME="loop-auto-${UNIQUE_ID}"

    # --- Create with a loop trigger ---
    run $ZERO_CLI automation create \
        -n "$AUTOMATION_NAME" \
        --agent "$COMPOSE_ID" \
        -p "Loop task every 5 minutes" \
        --loop 5m
    assert_success
    assert_output --partial "created"

    # --- Show ---
    run $ZERO_CLI automation show "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "loop"
    assert_output --partial "5m"

    # --- List ---
    run $ZERO_CLI automation list
    assert_success
    assert_output --partial "$AUTOMATION_NAME"

    # --- Disable / Enable ---
    run $ZERO_CLI automation disable "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "disabled"

    run $ZERO_CLI automation enable "$AUTOMATION_NAME"
    assert_success
    assert_output --partial "enabled"

    # --- Delete ---
    run $ZERO_CLI automation delete "$AUTOMATION_NAME" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "t20-3: zero schedule prints the rename notice" {
    run $ZERO_CLI schedule list
    assert_failure
    assert_output --partial "renamed"
    assert_output --partial "zero automation"
}
