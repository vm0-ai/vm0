#!/usr/bin/env bats

# Real Claude smoke tests — verify actual LLM execution (not mock).
# Requires ANTHROPIC_API_KEY set in CI via secrets.CI_ANTHROPIC_API_KEY.
#
# Test 1 (basic): cook + run with model-provider — baseline LLM execution
# Test 2 (flags): run with --append-system-prompt, --disallowed-tools, --settings
#   Verifies these flags reach the real Claude CLI without breaking execution.
#   Catches Commander.js argument parsing regressions (see #5788).

load '../../helpers/setup'

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set - required for real Claude tests"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-real-claude-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-real-claude-art-${UNIQUE_ID}"
    export VOLUME_NAME="e2e-real-claude-vol-${UNIQUE_ID}"

    # Create volume for claude-files (needed by both tests)
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null
    cd - >/dev/null

    # Set up model-provider once for all tests
    $CLI_COMMAND org model-provider setup \
        --type "anthropic-api-key" --secret "$ANTHROPIC_API_KEY"

    # Compose agents (one for basic, one for flags test)
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real Claude smoke test"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
  ${AGENT_NAME}-flags:
    description: "Real Claude flags test"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    $CLI_COMMAND compose "$TEST_DIR/vm0.yaml" >/dev/null
}

teardown_file() {
    # Clean up model provider (best-effort)
    $CLI_COMMAND org model-provider remove "anthropic-api-key" 2>/dev/null || true
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Test 1: Baseline — real Claude CLI processes a prompt and returns correct result
@test "t27-1: basic run with real claude" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    run timeout 120 $CLI_COMMAND run "$AGENT_NAME" \
        --model-provider "anthropic-api-key" \
        --debug-no-mock-claude \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=579"
}

# Test 2: CLI flags — verify --append-system-prompt, --disallowed-tools, and
# --settings pass through the guest-agent → Claude CLI pipeline without
# breaking execution. This catches Commander.js variadic argument bugs (#5788).
@test "t27-2: run with cli flags (append-system-prompt, disallowed-tools, settings)" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    run timeout 120 $CLI_COMMAND run "${AGENT_NAME}-flags" \
        --model-provider "anthropic-api-key" \
        --debug-no-mock-claude \
        --append-system-prompt "Always end your response with SIGNATURE=smoke-test" \
        --disallowed-tools CronCreate CronList CronDelete \
        --settings '{"permissions":{"allow":[]}}' \
        "Compute 789+101 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=890"
    # Verify --append-system-prompt reached Claude (agent follows the instruction)
    assert_output --partial "SIGNATURE=smoke-test"
}
