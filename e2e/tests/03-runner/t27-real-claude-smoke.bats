#!/usr/bin/env bats

# Real Claude smoke tests — verify actual LLM execution (not mock).
# Requires ANTHROPIC_API_KEY set in CI via secrets.CI_ANTHROPIC_API_KEY.
# The key is configured as an org model provider; the sandbox receives only
# the model-provider placeholder and mitmproxy performs the replacement.
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
# Test 4 (slash command): real Claude local zero-turn flow fails with the
#   structured no-history error instead of a checkpoint read failure.

load '../../helpers/setup'

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set - required for real Claude tests"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-real-claude-${UNIQUE_ID}"
    export VOLUME_NAME="e2e-real-claude-vol-${UNIQUE_ID}"

    # Create volume for claude-files (needed by these tests)
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    $ZERO_CLI org model-provider setup --type "anthropic-api-key" --secret "$ANTHROPIC_API_KEY" >/dev/null

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

    cat > "$TEST_DIR/vm0-settings.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}-settings:
    description: "Real Claude settings test"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    cat > "$TEST_DIR/vm0-slash.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}-slash:
    description: "Real Claude slash-command no-history test"
    framework: claude-code
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
    $VM0_CLI compose "$TEST_DIR/vm0-slash.yaml" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

ensure_anthropic_model_provider() {
    $ZERO_CLI org model-provider setup --type "anthropic-api-key" --secret "$ANTHROPIC_API_KEY" >/dev/null
}

# Test 0: Print sandbox Claude Code version for debugging
@test "t27-0: print sandbox claude version" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    ensure_anthropic_model_provider

    # Run claude --version inside the sandbox to confirm which binary is installed
    run $VM0_CLI run "$AGENT_NAME" \
        --model-provider-type "anthropic-api-key" \
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

    ensure_anthropic_model_provider

    run $VM0_CLI run "$AGENT_NAME" \
        --model-provider-type "anthropic-api-key" \
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

    ensure_anthropic_model_provider

    # "--" separates variadic --disallowed-tools from the prompt
    # (Commander.js <tools...> would otherwise swallow subsequent args)
    run $VM0_CLI run "${AGENT_NAME}-flags" \
        --model-provider-type "anthropic-api-key" \
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

    ensure_anthropic_model_provider

    # PreToolUse hook: write sentinel file before each Bash tool invocation.
    # Claude will read this file to prove the hook fired inside the sandbox.
    local settings='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo SETTINGS_HOOK_OK > /tmp/hook_sentinel.txt"}]}]}}'

    run $VM0_CLI run "${AGENT_NAME}-settings" \
        --model-provider-type "anthropic-api-key" \
        --debug-no-mock-claude \
        --settings "$settings" \
        -- "Step 1: run 'echo hello'. Step 2: run 'cat /tmp/hook_sentinel.txt'. Include the exact output of step 2 in your response."

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    # Sentinel file was created by PreToolUse hook and read by Claude
    assert_output --partial "SETTINGS_HOOK_OK"
}

# Test 4: real Claude slash-command local flow — verify zero-turn/no-history
# finalization is explicit and does not degrade into a checkpoint read error.
@test "t27-4: slash command no-history failure is structured" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    ensure_anthropic_model_provider

    run $VM0_CLI run "${AGENT_NAME}-slash" \
        --model-provider-type "anthropic-api-key" \
        --debug-no-mock-claude \
        "/help"

    assert_failure
    assert_output --partial "Run failed"
    assert_output --partial "Claude Code emitted a zero-turn result without creating session history"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    wait_for_log "$RUN_ID" --system -- \
        "Claude Code emitted a zero-turn result without creating session history" \
        "Skipping recovery checkpoint because no session history was created"

    refute_output --partial "Checkpoint failed:"
    refute_output --partial "Failed to read session history"
}
