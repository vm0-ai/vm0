#!/usr/bin/env bats

# Test VM0 --append-system-prompt flag (E2E happy path only)
# This test verifies that:
# 1. vm0 run with --append-system-prompt flag succeeds
# 2. The agent run completes successfully (full CLI → API → runner → sandbox pipeline)
#
# Note: mock-claude does not use the append-system-prompt value, so we cannot
# verify the text reached Claude. The value is validated to reach the sandbox
# via integration tests in create-run.test.ts and claim route.test.ts.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t44-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t44-$(date +%s%3N)-$RANDOM"
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
    description: "E2E test agent for append-system-prompt"
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

@test "t44-1: run with --append-system-prompt succeeds" {
    run $VM0_CLI run "$AGENT_NAME" \
        --append-system-prompt "Your name is Aria." \
        "echo hello"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "echo hello"
    assert_output --partial "◆ Claude Code Completed"
}
