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
    provider: claude-code
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
