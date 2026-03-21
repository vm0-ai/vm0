#!/usr/bin/env bats

# Real Claude smoke tests — verify actual LLM execution (not mock).
# Requires ANTHROPIC_API_KEY set in CI via secrets.CI_ANTHROPIC_API_KEY.
#
# Test 1 (basic): baseline LLM execution — math prompt, verify correct answer
# Test 2 (flags): --append-system-prompt, --disallowed-tools, --settings hooks
#   Verifies CLI flags pass through guest-agent → Claude CLI pipeline:
#   - Commander.js variadic arg parsing works (regression for #5788)
#   - append-system-prompt reaches Claude (verifiable via SIGNATURE)
#   - settings hooks execute in sandbox (verifiable via sentinel file)

load '../../helpers/setup'

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set - required for real Claude tests"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-real-claude-${UNIQUE_ID}"
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

    # Compose agents separately (only one agent per compose is supported)
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real Claude smoke test"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    cat > "$TEST_DIR/vm0-flags.yaml" <<EOF
version: "1.0"
agents:
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

    $CLI_COMMAND compose "$TEST_DIR/vm0-basic.yaml" >/dev/null
    $CLI_COMMAND compose "$TEST_DIR/vm0-flags.yaml" >/dev/null
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

# Test 2: CLI flags — verify the full guest-agent → Claude CLI flag pipeline.
#
# Uses a PreToolUse hook that writes a sentinel file before each Bash execution.
# The prompt asks Claude to:
#   Step 1: run "echo hello" (triggers hook → sentinel created)
#   Step 2: run "cat /tmp/hook-sentinel" (reads hook output → proves hook ran)
#
# Verifies three things in one test:
#   - --disallowed-tools doesn't swallow the prompt (#5788 regression)
#   - --append-system-prompt reaches Claude (SIGNATURE in response)
#   - --settings hooks execute in the sandbox (HOOK_OK in Bash output)
@test "t27-2: run with cli flags and settings hook verification" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    # PreToolUse hook: write sentinel before each Bash tool execution
    local SETTINGS='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo HOOK_OK > /tmp/hook-sentinel"}]}]}}'

    # "--" separates variadic --disallowed-tools from the prompt
    # (Commander.js <tools...> would otherwise swallow subsequent args)
    run timeout 120 $CLI_COMMAND run "${AGENT_NAME}-flags" \
        --model-provider "anthropic-api-key" \
        --debug-no-mock-claude \
        --append-system-prompt "Always end your final response with SIGNATURE=smoke-test" \
        --disallowed-tools CronCreate CronList CronDelete \
        --settings "$SETTINGS" \
        -- "Do these two steps using the Bash tool: Step 1: run 'echo hello'. Step 2: run 'cat /tmp/hook-sentinel'. Include all outputs."

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    # Verify prompt was not swallowed by variadic --disallowed-tools
    assert_output --partial "hello"
    # Verify --append-system-prompt reached Claude
    assert_output --partial "SIGNATURE=smoke-test"
    # Verify --settings hook executed in sandbox (sentinel created by PreToolUse hook)
    assert_output --partial "HOOK_OK"
}
