#!/usr/bin/env bats

# E2E tests for zero preference --timezone and TZ injection into sandbox
#
# These tests verify:
# 1. The zero preference command can set user timezone preference
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
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd "$TEST_DIR"

    # Create agent config
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E timezone test agent"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: ${VOLUME_NAME}
    version: latest
EOF

    $VM0_CLI compose vm0.yaml
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

# All timezone tests are in a single test to avoid racing on the global
# user-level timezone preference.  Two vm0 run calls (~15s each) + CLI
# commands (~5s) ≈ 35s, well within the 60s timeout.

@test "zero preference --timezone and TZ injection" {
    # --- preference set and read ---
    run $ZERO_CLI preference --timezone "Asia/Shanghai"
    assert_success
    assert_output --partial "Timezone set to"
    assert_output --partial "Asia/Shanghai"

    $ZERO_CLI preference --timezone "America/New_York" >/dev/null

    run $ZERO_CLI preference
    assert_success
    assert_output --partial "America/New_York"

    # --- reject invalid timezone ---
    run $ZERO_CLI preference --timezone "Invalid/Timezone"
    assert_failure
    assert_output --partial "Invalid timezone"

    # --- TZ injection into sandbox ---
    $ZERO_CLI preference --timezone "Asia/Tokyo" >/dev/null

    run $VM0_CLI run "$AGENT_NAME" \
        --verbose \
        "echo TZ=\$TZ"
    assert_success
    assert_output --partial "TZ=Asia/Tokyo"

    # --- explicit TZ overrides user preference ---
    $ZERO_CLI preference --timezone "Asia/Shanghai" >/dev/null

    local OVERRIDE_AGENT_NAME="tz-override-${UNIQUE_ID}"
    cat > "$TEST_DIR/vm0-tz-override.yaml" <<EOF
version: "1.0"

agents:
  ${OVERRIDE_AGENT_NAME}:
    description: "Agent with explicit TZ"
    framework: claude-code
    environment:
      TZ: "Europe/London"
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: ${VOLUME_NAME}
    version: latest
EOF

    $VM0_CLI compose "$TEST_DIR/vm0-tz-override.yaml" >/dev/null

    run $VM0_CLI run "$OVERRIDE_AGENT_NAME" \
        --verbose \
        "echo TZ=\$TZ"
    assert_success
    assert_output --partial "TZ=Europe/London"
}
