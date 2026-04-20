#!/usr/bin/env bats

# Real Claude smoke tests — verify actual LLM execution (not mock).
# Requires ANTHROPIC_API_KEY set in CI via secrets.CI_ANTHROPIC_API_KEY.
#
# Test 0 (version): print sandbox Claude Code version for debugging
# Test 1 (basic): baseline LLM execution — math prompt, verify correct answer
# Test 2 (flags): --append-system-prompt, --disallowed-tools
#   Verifies CLI flags pass through guest-agent → Claude CLI pipeline:
#   - Commander.js variadic arg parsing works (regression for #5788)
#   - append-system-prompt reaches Claude (verifiable via SIGNATURE)
# Test 3 (settings): --settings with PreToolUse hook
#   Verifies the full pipeline: API → claim route → runner → sandbox → hook fires
#   Regression test for #5832 (claim route omitted settings from response)

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
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Compose agents separately (only one agent per compose is supported)
    # ANTHROPIC_API_KEY is passed via --secrets at run time (not via model-provider)
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real Claude smoke test"
    framework: claude-code
    environment:
      ANTHROPIC_API_KEY: "\${{ secrets.ANTHROPIC_API_KEY }}"
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
    environment:
      ANTHROPIC_API_KEY: "\${{ secrets.ANTHROPIC_API_KEY }}"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    cat > "$TEST_DIR/vm0-settings.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}-settings:
    description: "Real Claude settings test"
    framework: claude-code
    environment:
      ANTHROPIC_API_KEY: "\${{ secrets.ANTHROPIC_API_KEY }}"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    $VM0_CLI compose "$TEST_DIR/vm0-basic.yaml" >/dev/null
    $VM0_CLI compose "$TEST_DIR/vm0-flags.yaml" >/dev/null
    $VM0_CLI compose "$TEST_DIR/vm0-settings.yaml" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Test 0: Print sandbox Claude Code version for debugging
@test "t27-0: print sandbox claude version" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    # Run claude --version inside the sandbox to confirm which binary is installed
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
        --debug-no-mock-claude \
        "Run 'claude --version' with the Bash tool and include the exact output"

    assert_success
    # Print output for CI log inspection
    echo "# Sandbox Claude version output:"
    echo "$output"
}

# Test 1: Baseline — real Claude CLI processes a prompt and returns correct result
@test "t27-1: basic run with real claude" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
        --debug-no-mock-claude \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=579"
}

# Test 2: CLI flags — verify the full guest-agent → Claude CLI flag pipeline.
#
# Verifies:
#   - --disallowed-tools doesn't swallow the prompt (#5788 regression)
#   - --append-system-prompt reaches Claude (SIGNATURE in response)
@test "t27-2: run with cli flags (append-system-prompt, disallowed-tools)" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    # "--" separates variadic --disallowed-tools from the prompt
    # (Commander.js <tools...> would otherwise swallow subsequent args)
    run $VM0_CLI run "${AGENT_NAME}-flags" \
        --secrets "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
        --debug-no-mock-claude \
        --append-system-prompt "Always end your final response with SIGNATURE=smoke-test" \
        --disallowed-tools CronCreate CronList CronDelete \
        -- "Compute 789+101 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=890"
    # Verify --append-system-prompt reached Claude (agent follows the instruction)
    assert_output --partial "SIGNATURE=smoke-test"
}

# Test 3: --settings with PreToolUse hook — verify settings reach the sandbox.
#
# Verifies the full pipeline: API → claim route → runner → guest-agent → Claude CLI.
# The PreToolUse hook writes a sentinel file before Bash executes; Claude then
# reads it to prove the hook fired. Regression test for #5832.
@test "t27-3: run with --settings hooks" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    # PreToolUse hook: write sentinel file before each Bash tool invocation.
    # Claude will read this file to prove the hook fired inside the sandbox.
    local settings='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo SETTINGS_HOOK_OK > /tmp/hook_sentinel.txt"}]}]}}'

    run $VM0_CLI run "${AGENT_NAME}-settings" \
        --secrets "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
        --debug-no-mock-claude \
        --settings "$settings" \
        -- "Step 1: run 'echo hello'. Step 2: run 'cat /tmp/hook_sentinel.txt'. Include the exact output of step 2 in your response."

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    # Sentinel file was created by PreToolUse hook and read by Claude
    assert_output --partial "SETTINGS_HOOK_OK"
}
