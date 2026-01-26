#!/usr/bin/env bats

# E2E tests for vm0 schedule commands (agent-centric)
# Tests: setup, list, status, enable, disable, delete
# Note: Actual cron execution is NOT tested (time-sensitive)

load '../../helpers/setup'

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="schedule-test-agent-${UNIQUE_ID}"
    export TEST_DIR="$(mktemp -d)"

    # Create vm0.yaml for the test agent
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test agent for schedule E2E tests"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    # Push the agent first (required for schedule to work)
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success
}

teardown() {
    # Clean up schedule if it exists
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        cd "$TEST_DIR" 2>/dev/null || true
        $CLI_COMMAND schedule delete "$AGENT_NAME" --force 2>/dev/null || true
        rm -rf "$TEST_DIR"
    fi
}

# ============================================================
# Setup tests (non-interactive mode with flags)
# ============================================================

@test "vm0 schedule setup should create a new schedule" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Run scheduled task"
    assert_success
    assert_output --partial "Created schedule"
    assert_output --partial "$AGENT_NAME"

    # Verify via status command
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * *"
    assert_output --partial "enabled"
}

@test "vm0 schedule setup should update existing schedule" {
    cd "$TEST_DIR"

    # Setup first time
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Run scheduled task"
    assert_success

    # Setup again with different config
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "10:00" \
        --timezone "America/New_York" \
        --prompt "Updated scheduled task"
    assert_success
    assert_output --partial "Updated schedule"

    # Verify updated time via status command
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Trigger:"
    assert_output --partial "0 10 * * *"
}

@test "vm0 schedule setup with weekly frequency" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency weekly \
        --time "09:00" \
        --day "mon" \
        --timezone "UTC" \
        --prompt "Weekly task"
    assert_success
    assert_output --partial "Created schedule"

    # Verify weekly cron expression via status (Monday = 1)
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * 1"
}

@test "vm0 schedule setup with monthly frequency" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency monthly \
        --time "09:00" \
        --day "15" \
        --timezone "UTC" \
        --prompt "Monthly task"
    assert_success
    assert_output --partial "Created schedule"

    # Verify monthly cron expression via status (15th of month)
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 15 * *"
}

@test "vm0 schedule setup with once frequency" {
    cd "$TEST_DIR"

    # Calculate a future date (tomorrow)
    local FUTURE_DATE=$(date -d "+1 day" "+%Y-%m-%d")

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency once \
        --time "14:30" \
        --day "$FUTURE_DATE" \
        --timezone "UTC" \
        --prompt "One-time task"
    assert_success
    assert_output --partial "Created schedule"

    # Verify one-time schedule via status
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Trigger:"
    assert_output --partial "(one-time)"
}

@test "vm0 schedule setup with vars" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Task with vars" \
        --var "ENV=test" \
        --var "DEBUG=true"
    assert_success
    assert_output --partial "Created schedule"

    # Verify vars in status
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Variables:"
    assert_output --partial "ENV"
    assert_output --partial "DEBUG"
}

@test "vm0 schedule setup with secrets" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Task with secrets" \
        --secret "API_KEY=my-secret"
    assert_success
    assert_output --partial "Created schedule"

    # Verify secrets in status
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Secrets:"
    assert_output --partial "API_KEY"
}

@test "vm0 schedule setup with artifact-name" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Task with custom artifact" \
        --artifact-name "my-artifact"
    assert_success
    assert_output --partial "Created schedule"

    # Verify artifact via status command
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Artifact:"
    assert_output --partial "my-artifact"
}

# ============================================================
# List tests
# ============================================================

@test "vm0 schedule list should show created schedules" {
    cd "$TEST_DIR"

    # Setup a schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "List test task"
    assert_success

    # List schedules
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "AGENT"
    assert_output --partial "enabled"
}

@test "vm0 schedule list should show empty message when no schedules" {
    # Skip setup - test with fresh state
    # Note: We can't guarantee no schedules exist, so we just check the command works
    run $CLI_COMMAND schedule list
    assert_success
}

# ============================================================
# Status tests
# ============================================================

@test "vm0 schedule status should show schedule details" {
    cd "$TEST_DIR"

    # Setup a schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Status test task"
    assert_success

    # Get status using agent name
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "Status:"
    assert_output --partial "enabled"
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * *"
}

@test "vm0 schedule status should accept --limit option" {
    cd "$TEST_DIR"

    # Setup a schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Limit test task"
    assert_success

    # Get status with --limit
    run $CLI_COMMAND schedule status "$AGENT_NAME" --limit 10
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
}

@test "vm0 schedule status should accept -l shorthand for limit" {
    cd "$TEST_DIR"

    # Setup a schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Limit shorthand test"
    assert_success

    # Get status with -l shorthand
    run $CLI_COMMAND schedule status "$AGENT_NAME" -l 5
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
}

@test "vm0 schedule status with --limit 0 should hide runs section" {
    cd "$TEST_DIR"

    # Setup a schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Limit zero test"
    assert_success

    # Get status with --limit 0
    run $CLI_COMMAND schedule status "$AGENT_NAME" --limit 0
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
    # Should not show "Recent Runs" when limit is 0
    refute_output --partial "Recent Runs:"
}

# ============================================================
# Enable/Disable tests
# ============================================================

@test "vm0 schedule disable should disable a schedule" {
    cd "$TEST_DIR"

    # Setup and disable
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Disable test task"
    assert_success

    run $CLI_COMMAND schedule disable "$AGENT_NAME"
    assert_success
    assert_output --partial "Disabled"

    # Verify disabled in list
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "disabled"
}

@test "vm0 schedule enable should enable a disabled schedule" {
    cd "$TEST_DIR"

    # Setup, disable, then enable
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Enable test task"
    assert_success

    run $CLI_COMMAND schedule disable "$AGENT_NAME"
    assert_success

    run $CLI_COMMAND schedule enable "$AGENT_NAME"
    assert_success
    assert_output --partial "Enabled"

    # Verify enabled in list
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "enabled"
}

# ============================================================
# Delete tests
# ============================================================

@test "vm0 schedule delete should delete a schedule" {
    cd "$TEST_DIR"

    # Setup first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Delete test task"
    assert_success

    # Delete with force flag
    run $CLI_COMMAND schedule delete "$AGENT_NAME" --force
    assert_success
    assert_output --partial "Deleted"
}

# ============================================================
# Error handling tests
# ============================================================

@test "vm0 schedule status fails for nonexistent agent" {
    run $CLI_COMMAND schedule status "nonexistent-agent-12345"
    assert_failure
    assert_output --partial "No schedule found"
}

@test "vm0 schedule setup fails for nonexistent agent" {
    run $CLI_COMMAND schedule setup "nonexistent-agent-12345" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Test"
    assert_failure
    assert_output --partial "not found"
}

# ============================================================
# Global resolution tests (commands work from any directory)
# ============================================================

@test "vm0 schedule status should work from any directory (global resolution)" {
    cd "$TEST_DIR"

    # Setup schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Global resolution test"
    assert_success

    # Change to a completely different directory (NOT the agent's directory)
    cd /tmp

    # Status should still work with just the agent name
    run $CLI_COMMAND schedule status "$AGENT_NAME"
    assert_success
    assert_output --partial "Agent:"
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "enabled"
}

@test "vm0 schedule disable should work from any directory (global resolution)" {
    cd "$TEST_DIR"

    # Setup schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Global disable test"
    assert_success

    # Change to a different directory
    cd /tmp

    # Disable should still work with just the agent name
    run $CLI_COMMAND schedule disable "$AGENT_NAME"
    assert_success
    assert_output --partial "Disabled"
}

@test "vm0 schedule enable should work from any directory (global resolution)" {
    cd "$TEST_DIR"

    # Setup and disable schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Global enable test"
    assert_success

    run $CLI_COMMAND schedule disable "$AGENT_NAME"
    assert_success

    # Change to a different directory
    cd /tmp

    # Enable should still work with just the agent name
    run $CLI_COMMAND schedule enable "$AGENT_NAME"
    assert_success
    assert_output --partial "Enabled"
}

@test "vm0 schedule delete should work from any directory (global resolution)" {
    cd "$TEST_DIR"

    # Setup schedule first
    run $CLI_COMMAND schedule setup "$AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Global delete test"
    assert_success

    # Change to a different directory
    cd /tmp

    # Delete should still work with just the agent name
    run $CLI_COMMAND schedule delete "$AGENT_NAME" --force
    assert_success
    assert_output --partial "Deleted"
}

# ============================================================
# Secrets/Vars validation tests
# ============================================================

@test "vm0 schedule setup fails when required secrets are missing" {
    local SECRET_AGENT_NAME="secrets-test-agent-${UNIQUE_ID}"
    local SECRET_TEST_DIR="$(mktemp -d)"

    # Create agent with secrets requirement
    cat > "$SECRET_TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${SECRET_AGENT_NAME}:
    description: "Test agent with secrets requirement"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: "\${{ secrets.API_KEY }}"
EOF

    cd "$SECRET_TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    # Try to setup schedule without providing required secret
    run $CLI_COMMAND schedule setup "$SECRET_AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Should fail"
    assert_failure
    assert_output --partial "Missing required configuration"
    assert_output --partial "API_KEY"

    # Clean up
    $CLI_COMMAND schedule delete "$SECRET_AGENT_NAME" --force 2>/dev/null || true
    rm -rf "$SECRET_TEST_DIR"
}

@test "vm0 schedule setup succeeds when required secrets are provided" {
    local SECRET_AGENT_NAME="secrets-provided-agent-${UNIQUE_ID}"
    local SECRET_TEST_DIR="$(mktemp -d)"

    # Create agent with secrets requirement
    cat > "$SECRET_TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${SECRET_AGENT_NAME}:
    description: "Test agent with secrets requirement"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: "\${{ secrets.API_KEY }}"
EOF

    cd "$SECRET_TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    # Setup schedule with required secret provided
    run $CLI_COMMAND schedule setup "$SECRET_AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Should succeed" \
        --secret "API_KEY=test-secret-value"
    assert_success
    assert_output --partial "Created schedule"

    # Verify secret is shown in status
    run $CLI_COMMAND schedule status "$SECRET_AGENT_NAME"
    assert_success
    assert_output --partial "Secrets:"
    assert_output --partial "API_KEY"

    # Clean up
    $CLI_COMMAND schedule delete "$SECRET_AGENT_NAME" --force 2>/dev/null || true
    rm -rf "$SECRET_TEST_DIR"
}

@test "vm0 schedule setup fails when required vars are missing" {
    local VAR_AGENT_NAME="vars-test-agent-${UNIQUE_ID}"
    local VAR_TEST_DIR="$(mktemp -d)"

    # Create agent with vars requirement
    cat > "$VAR_TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${VAR_AGENT_NAME}:
    description: "Test agent with vars requirement"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_URL: "\${{ vars.API_URL }}"
EOF

    cd "$VAR_TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    # Try to setup schedule without providing required var
    run $CLI_COMMAND schedule setup "$VAR_AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Should fail"
    assert_failure
    assert_output --partial "Missing required configuration"
    assert_output --partial "API_URL"

    # Clean up
    $CLI_COMMAND schedule delete "$VAR_AGENT_NAME" --force 2>/dev/null || true
    rm -rf "$VAR_TEST_DIR"
}

@test "vm0 schedule setup succeeds when required vars are provided" {
    local VAR_AGENT_NAME="vars-provided-agent-${UNIQUE_ID}"
    local VAR_TEST_DIR="$(mktemp -d)"

    # Create agent with vars requirement
    cat > "$VAR_TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${VAR_AGENT_NAME}:
    description: "Test agent with vars requirement"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_URL: "\${{ vars.API_URL }}"
EOF

    cd "$VAR_TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    # Setup schedule with required var provided
    run $CLI_COMMAND schedule setup "$VAR_AGENT_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Should succeed" \
        --var "API_URL=https://api.example.com"
    assert_success
    assert_output --partial "Created schedule"

    # Verify var is shown in status
    run $CLI_COMMAND schedule status "$VAR_AGENT_NAME"
    assert_success
    assert_output --partial "Variables:"
    assert_output --partial "API_URL"

    # Clean up
    $CLI_COMMAND schedule delete "$VAR_AGENT_NAME" --force 2>/dev/null || true
    rm -rf "$VAR_TEST_DIR"
}
