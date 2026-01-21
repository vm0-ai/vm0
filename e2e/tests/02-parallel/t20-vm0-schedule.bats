#!/usr/bin/env bats

# E2E tests for vm0 schedule commands
# Tests: deploy, list, status, enable, disable, delete
# Note: Actual cron execution is NOT tested (time-sensitive)

load '../../helpers/setup'

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="schedule-test-agent-${UNIQUE_ID}"
    export SCHEDULE_NAME="test-schedule-${UNIQUE_ID}"
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

    # Create schedule.yaml
    cat > "$TEST_DIR/schedule.yaml" <<EOF
version: "1.0"

schedules:
  ${SCHEDULE_NAME}:
    on:
      cron: "0 9 * * *"
      timezone: "UTC"
    run:
      agent: "${AGENT_NAME}"
      prompt: "Run scheduled task"
      vars:
        ENV: "test"
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
        $CLI_COMMAND schedule delete "$SCHEDULE_NAME" --force 2>/dev/null || true
        rm -rf "$TEST_DIR"
    fi
}

# ============================================================
# Deploy tests
# ============================================================

@test "vm0 schedule deploy should create a new schedule" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success
    assert_output --partial "Created schedule"
    assert_output --partial "$SCHEDULE_NAME"
}

@test "vm0 schedule deploy should update existing schedule" {
    cd "$TEST_DIR"

    # Deploy first time
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # Update schedule.yaml with different cron
    cat > "$TEST_DIR/schedule.yaml" <<EOF
version: "1.0"

schedules:
  ${SCHEDULE_NAME}:
    on:
      cron: "0 10 * * *"
      timezone: "America/New_York"
    run:
      agent: "${AGENT_NAME}"
      prompt: "Updated scheduled task"
EOF

    # Deploy again
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success
    assert_output --partial "Updated schedule"
}

@test "vm0 schedule deploy should fail with invalid cron expression" {
    cd "$TEST_DIR"

    cat > "$TEST_DIR/bad-schedule.yaml" <<EOF
version: "1.0"

schedules:
  bad-schedule:
    on:
      cron: "invalid cron"
      timezone: "UTC"
    run:
      agent: "${AGENT_NAME}"
      prompt: "This should fail"
EOF

    run $CLI_COMMAND schedule deploy bad-schedule.yaml
    assert_failure
}

# ============================================================
# List tests
# ============================================================

@test "vm0 schedule list should show deployed schedules" {
    cd "$TEST_DIR"

    # Deploy a schedule first
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # List schedules
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "$SCHEDULE_NAME"
    assert_output --partial "enabled"
}

@test "vm0 schedule list should show empty message when no schedules" {
    cd "$TEST_DIR"

    # List without deploying
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "No schedules found"
}

# ============================================================
# Status tests
# ============================================================

@test "vm0 schedule status should show schedule details" {
    cd "$TEST_DIR"

    # Deploy a schedule first
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # Get status
    run $CLI_COMMAND schedule status "$SCHEDULE_NAME"
    assert_success
    assert_output --partial "Schedule: $SCHEDULE_NAME"
    assert_output --partial "Status:"
    assert_output --partial "enabled"
    assert_output --partial "Trigger:"
    assert_output --partial "0 9 * * *"
}

@test "vm0 schedule status should fail for non-existent schedule" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule status "non-existent-schedule"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 schedule status should accept --limit option" {
    cd "$TEST_DIR"

    # Deploy a schedule first
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # Get status with --limit
    run $CLI_COMMAND schedule status "$SCHEDULE_NAME" --limit 10
    assert_success
    assert_output --partial "Schedule: $SCHEDULE_NAME"
}

@test "vm0 schedule status should accept -l shorthand for limit" {
    cd "$TEST_DIR"

    # Deploy a schedule first
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # Get status with -l shorthand
    run $CLI_COMMAND schedule status "$SCHEDULE_NAME" -l 5
    assert_success
    assert_output --partial "Schedule: $SCHEDULE_NAME"
}

@test "vm0 schedule status with --limit 0 should hide runs section" {
    cd "$TEST_DIR"

    # Deploy a schedule first
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # Get status with --limit 0
    run $CLI_COMMAND schedule status "$SCHEDULE_NAME" --limit 0
    assert_success
    assert_output --partial "Schedule: $SCHEDULE_NAME"
    # Should not show "Recent Runs" when limit is 0
    refute_output --partial "Recent Runs:"
}

# ============================================================
# Enable/Disable tests
# ============================================================

@test "vm0 schedule disable should disable a schedule" {
    cd "$TEST_DIR"

    # Deploy and disable
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    run $CLI_COMMAND schedule disable "$SCHEDULE_NAME"
    assert_success
    assert_output --partial "Disabled"

    # Verify disabled in list
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "disabled"
}

@test "vm0 schedule enable should enable a disabled schedule" {
    cd "$TEST_DIR"

    # Deploy, disable, then enable
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    run $CLI_COMMAND schedule disable "$SCHEDULE_NAME"
    assert_success

    run $CLI_COMMAND schedule enable "$SCHEDULE_NAME"
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

    # Deploy first
    run $CLI_COMMAND schedule deploy schedule.yaml
    assert_success

    # Delete with force flag
    run $CLI_COMMAND schedule delete "$SCHEDULE_NAME" --force
    assert_success
    assert_output --partial "Deleted"

    # Verify it's gone
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "No schedules found"
}

@test "vm0 schedule delete should fail for non-existent schedule" {
    cd "$TEST_DIR"

    run $CLI_COMMAND schedule delete "non-existent-schedule" --force
    assert_failure
    assert_output --partial "not found"
}

# ============================================================
# Secrets handling tests
# ============================================================

@test "vm0 schedule deploy should handle secrets" {
    cd "$TEST_DIR"

    # Create schedule with secrets using env var expansion
    export SECRET_VALUE="my-secret-value"
    cat > "$TEST_DIR/schedule-secrets.yaml" <<EOF
version: "1.0"

schedules:
  ${SCHEDULE_NAME}:
    on:
      cron: "0 9 * * *"
      timezone: "UTC"
    run:
      agent: "${AGENT_NAME}"
      prompt: "Run with secrets"
      secrets:
        API_KEY: "\${SECRET_VALUE}"
EOF

    run $CLI_COMMAND schedule deploy schedule-secrets.yaml
    assert_success

    # Status should show secret names
    run $CLI_COMMAND schedule status "$SCHEDULE_NAME"
    assert_success
    assert_output --partial "Secrets:"
    assert_output --partial "API_KEY"
}

# ============================================================
# Init tests (non-interactive mode with flags)
# ============================================================

@test "vm0 schedule init should create schedule.yaml with daily frequency" {
    cd "$TEST_DIR"

    # Remove existing schedule.yaml to test init
    rm -f schedule.yaml

    run $CLI_COMMAND schedule init \
        --name "$SCHEDULE_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Daily task" \
        --no-vars
    assert_success
    assert_output --partial "Created schedule.yaml"

    # Verify file was created
    assert [ -f "schedule.yaml" ]

    # Verify content
    run cat schedule.yaml
    assert_output --partial "version: \"1.0\""
    assert_output --partial "$SCHEDULE_NAME"
    assert_output --partial "cron:"
    assert_output --partial "0 9 * * *"
    assert_output --partial "Daily task"
}

@test "vm0 schedule init should create schedule.yaml with weekly frequency" {
    cd "$TEST_DIR"

    rm -f schedule.yaml

    run $CLI_COMMAND schedule init \
        --name "$SCHEDULE_NAME" \
        --frequency weekly \
        --time "10:30" \
        --day "mon" \
        --timezone "America/New_York" \
        --prompt "Weekly task" \
        --no-vars
    assert_success
    assert_output --partial "Created schedule.yaml"

    # Verify cron for Monday at 10:30
    run cat schedule.yaml
    assert_output --partial "30 10 * * 1"
}

@test "vm0 schedule init should create schedule.yaml with monthly frequency" {
    cd "$TEST_DIR"

    rm -f schedule.yaml

    run $CLI_COMMAND schedule init \
        --name "$SCHEDULE_NAME" \
        --frequency monthly \
        --time "12:00" \
        --day "15" \
        --timezone "UTC" \
        --prompt "Monthly task" \
        --no-vars
    assert_success
    assert_output --partial "Created schedule.yaml"

    # Verify cron for 15th at 12:00
    run cat schedule.yaml
    assert_output --partial "0 12 15 * *"
}

@test "vm0 schedule init generated file should be deployable" {
    cd "$TEST_DIR"

    rm -f schedule.yaml

    # Create schedule.yaml using init
    run $CLI_COMMAND schedule init \
        --name "$SCHEDULE_NAME" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Deployable task" \
        --no-vars
    assert_success

    # Deploy the generated file
    run $CLI_COMMAND schedule deploy
    assert_success
    assert_output --partial "Created schedule"

    # Verify it appears in list
    run $CLI_COMMAND schedule list
    assert_success
    assert_output --partial "$SCHEDULE_NAME"
}

@test "vm0 schedule init should fail when vm0.yaml does not exist" {
    # Create a temp directory without vm0.yaml
    local EMPTY_DIR="$(mktemp -d)"
    cd "$EMPTY_DIR"

    run $CLI_COMMAND schedule init \
        --name "test-schedule" \
        --frequency daily \
        --time "09:00" \
        --timezone "UTC" \
        --prompt "Should fail" \
        --no-vars
    assert_failure
    assert_output --partial "No vm0.yaml found"

    rm -rf "$EMPTY_DIR"
}

@test "vm0 schedule init should require --force to overwrite existing file" {
    cd "$TEST_DIR"

    # schedule.yaml already exists from setup
    assert [ -f "schedule.yaml" ]

    # Try init without --force (non-interactive should fail)
    run $CLI_COMMAND schedule init \
        --name "new-schedule" \
        --frequency daily \
        --time "10:00" \
        --timezone "UTC" \
        --prompt "New task" \
        --no-vars
    assert_failure
    assert_output --partial "schedule.yaml already exists"
}

@test "vm0 schedule init with --force should overwrite existing file" {
    cd "$TEST_DIR"

    # schedule.yaml already exists from setup
    assert [ -f "schedule.yaml" ]

    # Init with --force
    run $CLI_COMMAND schedule init \
        --name "new-schedule-${UNIQUE_ID}" \
        --frequency daily \
        --time "11:00" \
        --timezone "UTC" \
        --prompt "Overwritten task" \
        --no-vars \
        --force
    assert_success
    assert_output --partial "Created schedule.yaml"

    # Verify new content
    run cat schedule.yaml
    assert_output --partial "Overwritten task"
    assert_output --partial "0 11 * * *"
}

@test "vm0 schedule init with --frequency once should require interactive mode" {
    cd "$TEST_DIR"

    rm -f schedule.yaml

    # One-time schedules require interactive mode
    run $CLI_COMMAND schedule init \
        --name "$SCHEDULE_NAME" \
        --frequency once \
        --timezone "UTC" \
        --prompt "One-time task" \
        --no-vars
    assert_failure
    assert_output --partial "One-time schedules require interactive mode"
}

# ============================================================
# One-time schedule (at: format) deploy tests
# ============================================================

@test "vm0 schedule deploy should handle at: format for one-time schedules" {
    cd "$TEST_DIR"

    # Calculate a future date (tomorrow)
    local FUTURE_DATE=$(date -d "+1 day" "+%Y-%m-%d")

    # Create schedule with at: format (human-readable)
    cat > "$TEST_DIR/schedule-onetime.yaml" <<EOF
version: "1.0"

schedules:
  ${SCHEDULE_NAME}:
    on:
      at: "${FUTURE_DATE} 14:30"
      timezone: "UTC"
    run:
      agent: "${AGENT_NAME}"
      prompt: "One-time scheduled task"
EOF

    run $CLI_COMMAND schedule deploy schedule-onetime.yaml
    assert_success
    assert_output --partial "Created schedule"

    # Verify in status - one-time schedules show "(one-time)" in trigger
    run $CLI_COMMAND schedule status "$SCHEDULE_NAME"
    assert_success
    assert_output --partial "(one-time)"
}
