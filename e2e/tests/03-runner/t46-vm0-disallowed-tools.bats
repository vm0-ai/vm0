#!/usr/bin/env bats

# Test VM0 --disallowed-tools and --tools flags (E2E happy path only)
# This test verifies that:
# 1. vm0 run with --disallowed-tools flag succeeds (prompt is not swallowed)
# 2. vm0 run with --tools flag succeeds (prompt is not swallowed)
#
# These flags use Commander.js variadic options (<tools...>) which greedily
# consume subsequent positional arguments. The guest-agent must insert "--"
# before the prompt to prevent the prompt from being consumed as a tool name.
# See: https://github.com/vm0-ai/vm0/issues/5788

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t46-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t46-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create inline config with unique agent name
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for disallowed-tools"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t46-1: run with --disallowed-tools succeeds" {
    # "--" separates variadic --disallowed-tools from the prompt
    # (Commander.js <tools...> would otherwise swallow the prompt)
    run $VM0_CLI run "$AGENT_NAME" \
        --disallowed-tools CronCreate CronList CronDelete \
        -- "echo hello"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "echo hello"
    assert_output --partial "◆ Claude Code Completed"
}

@test "t46-2: run with --tools succeeds" {
    # "--" separates variadic --tools from the prompt
    run $VM0_CLI run "$AGENT_NAME" \
        --tools Bash \
        -- "echo hello"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "echo hello"
    assert_output --partial "◆ Claude Code Completed"
}
