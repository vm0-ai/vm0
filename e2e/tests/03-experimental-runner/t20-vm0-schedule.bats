#!/usr/bin/env bats

# E2E tests for vm0 schedule commands - Happy Path Only
#
# These tests verify the complete integration works end-to-end.
# Error cases, input variations, and edge cases are tested in:
# - turbo/apps/cli/src/commands/schedule/__tests__/*.test.ts (command-level with MSW)
# - turbo/apps/web/app/api/agent/schedules/**/__tests__/route.test.ts (API routes)
#
# Test Structure:
# - setup_file: Creates shared agent ONCE for all tests, saves state to BATS_FILE_TMPDIR
# - teardown_file: Cleans up agent ONCE after all tests
# - Each @test: Loads state from BATS_FILE_TMPDIR and uses the shared agent

load '../../helpers/setup'

setup_file() {
    local UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    local AGENT_NAME="schedule-e2e-${UNIQUE_ID}"
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
    description: "E2E schedule test agent"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    cd "$TEST_DIR"
    $CLI_COMMAND compose vm0.yaml
}

teardown_file() {
    # Load state from files
    local AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name" 2>/dev/null || true)
    local TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir" 2>/dev/null || true)

    # Clean up schedule and temp directory
    if [ -n "$AGENT_NAME" ]; then
        $CLI_COMMAND schedule delete "$AGENT_NAME" --force 2>/dev/null || true
    fi
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

setup() {
    # Load state from files (required for BATS parallel execution)
    UNIQUE_ID=$(cat "$BATS_FILE_TMPDIR/unique_id")
    AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name")
    TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir")
    cd "$TEST_DIR"
}

# ============================================================
# Happy Path Tests
# ============================================================

@test "vm0 schedule setup creates a new schedule" {
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Run scheduled task"
    assert_success
    assert_output --partial "Created schedule"
    assert_output --partial "$AGENT_NAME"
}

@test "vm0 schedule list shows created schedules" {
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "AGENT"
    assert_output --partial "disabled"
}

@test "vm0 schedule status shows schedule details" {
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "Status:"
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * *"
}

@test "vm0 schedule setup updates existing schedule" {
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "10:00" \
        --timezone "America/New_York" \
        --prompt "Updated scheduled task"
    assert_success
    assert_output --partial "Updated schedule"

    # Verify update via status
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "0 10 * * *"
}

@test "vm0 schedule enable/disable workflow" {
    # Enable the schedule
    run $CLI_COMMAND schedule enable "$AGENT_NAME"
    assert_success
    assert_output --partial "Enabled"

    # Verify enabled in list
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "enabled"

    # Disable the schedule
    run $CLI_COMMAND schedule disable "$AGENT_NAME"
    assert_success
    assert_output --partial "Disabled"

    # Verify disabled in list
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "disabled"
}

@test "vm0 schedule delete removes schedule" {
    # First create a fresh schedule to delete
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "11:00" \
        --timezone "UTC" \
        --prompt "To be deleted"
    assert_success

    # Delete with force flag
    run $CLI_COMMAND schedule delete "$AGENT_NAME" --force
    assert_success
    assert_output --partial "Deleted"
}

# ============================================================
# Secrets/Vars Integration Test
# Uses a separate agent with configuration requirements
# Secrets and vars are now managed via platform tables
# ============================================================

@test "vm0 schedule setup with platform secrets and vars" {
    local CONFIG_AGENT_NAME="schedule-config-${UNIQUE_ID}"
    local CONFIG_TEST_DIR="$(mktemp -d)"

    # Create agent with secrets and vars requirements
    cat > "$CONFIG_TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${CONFIG_AGENT_NAME}:
    description: "Test agent with configuration requirements"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      SCHEDULE_TEST_API_KEY: "\${{ secrets.SCHEDULE_TEST_API_KEY }}"
      SCHEDULE_TEST_API_URL: "\${{ vars.SCHEDULE_TEST_API_URL }}"
      SCHEDULE_TEST_DEBUG: "\${{ vars.SCHEDULE_TEST_DEBUG }}"
EOF

    cd "$CONFIG_TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    # Set secret via platform
    run $CLI_COMMAND secret set SCHEDULE_TEST_API_KEY --body "test-api-key-value"
    assert_success

    # Set vars via platform
    run $CLI_COMMAND variable set SCHEDULE_TEST_API_URL "https://api.example.com"
    assert_success
    run $CLI_COMMAND variable set SCHEDULE_TEST_DEBUG "true"
    assert_success

    # Setup schedule (secrets and vars come from platform tables, not CLI flags)
    run $CLI_COMMAND schedule setup "$CONFIG_AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Task with config"
    assert_success
    assert_output --partial "Created schedule"

    # Verify schedule was created
    run $CLI_COMMAND schedule status "$CONFIG_AGENT_NAME"
    assert_success

    # Clean up
    $CLI_COMMAND schedule delete "$CONFIG_AGENT_NAME" --force 2>/dev/null || true
    $CLI_COMMAND secret delete SCHEDULE_TEST_API_KEY -y 2>/dev/null || true
    $CLI_COMMAND variable delete SCHEDULE_TEST_API_URL -y 2>/dev/null || true
    $CLI_COMMAND variable delete SCHEDULE_TEST_DEBUG -y 2>/dev/null || true
    rm -rf "$CONFIG_TEST_DIR"
}
