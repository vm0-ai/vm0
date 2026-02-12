#!/usr/bin/env bats

# E2E tests for vm0 timezone command and TZ injection into sandbox
#
# These tests verify:
# 1. The vm0 timezone command can set user timezone preference
# 2. The TZ environment variable is correctly injected into sandbox
#
# Test Structure:
# - setup_file: Creates shared agent and volume ONCE for all tests
# - teardown_file: Cleans up after all tests
# - Each @test: Uses shared agent to verify timezone functionality

load '../../helpers/setup'

setup_file() {
    local UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    local AGENT_NAME="timezone-e2e-${UNIQUE_ID}"
    local VOLUME_NAME="tz-vol-${UNIQUE_ID}"
    local TEST_DIR="$(mktemp -d)"

    # Save state to persist across tests
    echo "$UNIQUE_ID" > "$BATS_FILE_TMPDIR/unique_id"
    echo "$AGENT_NAME" > "$BATS_FILE_TMPDIR/agent_name"
    echo "$VOLUME_NAME" > "$BATS_FILE_TMPDIR/volume_name"
    echo "$TEST_DIR" > "$BATS_FILE_TMPDIR/test_dir"

    # Create volume for the agent
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
Test volume for timezone E2E tests.
VOLEOF
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd "$TEST_DIR"

    # Create agent config
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E timezone test agent"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: ${VOLUME_NAME}
    version: latest
EOF

    $CLI_COMMAND compose vm0.yaml
}

teardown_file() {
    local TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir" 2>/dev/null || true)

    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

setup() {
    # Load state from files
    UNIQUE_ID=$(cat "$BATS_FILE_TMPDIR/unique_id")
    AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name")
    VOLUME_NAME=$(cat "$BATS_FILE_TMPDIR/volume_name")
    TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir")
    cd "$TEST_DIR"
}

# ============================================================
# vm0 timezone command tests
# ============================================================

@test "vm0 timezone sets user preference" {
    run $CLI_COMMAND timezone "Asia/Shanghai"
    assert_success
    assert_output --partial "Timezone set to"
    assert_output --partial "Asia/Shanghai"
}

@test "vm0 timezone shows current preference" {
    # Set a timezone first
    $CLI_COMMAND timezone "America/New_York" >/dev/null

    run $CLI_COMMAND timezone
    assert_success
    assert_output --partial "America/New_York"
}

@test "vm0 timezone rejects invalid timezone" {
    run $CLI_COMMAND timezone "Invalid/Timezone"
    assert_failure
    assert_output --partial "Invalid timezone"
}

# ============================================================
# TZ environment variable injection tests
# ============================================================

@test "sandbox receives TZ environment variable from user preference" {
    # Set timezone preference
    $CLI_COMMAND timezone "Asia/Tokyo" >/dev/null

    # Run agent and check TZ environment variable
    run $CLI_COMMAND run "$AGENT_NAME" \
        --verbose \
        "echo TZ=\$TZ"
    assert_success
    assert_output --partial "TZ=Asia/Tokyo"
}

@test "explicit TZ in environment overrides user preference" {
    # Set user timezone preference
    $CLI_COMMAND timezone "Asia/Shanghai" >/dev/null

    # Create agent config with explicit TZ in environment
    local OVERRIDE_AGENT_NAME="tz-override-${UNIQUE_ID}"
    cat > "$TEST_DIR/vm0-tz-override.yaml" <<EOF
version: "1.0"

agents:
  ${OVERRIDE_AGENT_NAME}:
    description: "Agent with explicit TZ"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      TZ: "Europe/London"
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: ${VOLUME_NAME}
    version: latest
EOF

    $CLI_COMMAND compose "$TEST_DIR/vm0-tz-override.yaml" >/dev/null

    # Run agent - explicit TZ should take precedence
    run $CLI_COMMAND run "$OVERRIDE_AGENT_NAME" \
        --verbose \
        "echo TZ=\$TZ"
    assert_success
    assert_output --partial "TZ=Europe/London"
}
