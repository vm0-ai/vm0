#!/usr/bin/env bats

# Real Claude smoke tests — verify actual LLM execution (not mock).
# Requires ANTHROPIC_API_KEY set in CI via secrets.CI_ANTHROPIC_API_KEY.
# The key is configured as an org model provider; the sandbox receives only
# the model-provider placeholder and mitmproxy performs the replacement.
#
# Test 0 (version): print sandbox Claude Code version for debugging
# Test 1 (basic): baseline LLM execution — math prompt, verify correct answer
# Test 2 (options): appendSystemPrompt, disallowedTools
#   Verifies structured run options pass through guest-agent → Claude.
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
    # Org provider setup supplies the API key; compose env pins the model.
    export REAL_CLAUDE_MODEL="claude-haiku-4-5"

    # Create volume for claude-files (needed by these tests)
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    $ZERO_CLI org model-provider setup --type "anthropic-api-key" --secret "$ANTHROPIC_API_KEY" >/dev/null

    # Compose agents separately (only one agent per compose is supported)
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real Claude smoke test"
    framework: claude-code
    environment:
      ANTHROPIC_MODEL: "$REAL_CLAUDE_MODEL"
    volumes:
      - claude-files:/home/user/.claude
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
      ANTHROPIC_MODEL: "$REAL_CLAUDE_MODEL"
    volumes:
      - claude-files:/home/user/.claude
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
      ANTHROPIC_MODEL: "$REAL_CLAUDE_MODEL"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    seed_compose_fixture "$TEST_DIR/vm0-basic.yaml" >/dev/null
    seed_compose_fixture "$TEST_DIR/vm0-flags.yaml" >/dev/null
    seed_compose_fixture "$TEST_DIR/vm0-settings.yaml" >/dev/null
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
    run run_compose_fixture "$AGENT_NAME" \
        "Run 'claude --version' with the Bash tool and include the exact output" \
        '{"modelProviderType":"anthropic-api-key","realAgentInPreview":true}'

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

    run run_compose_fixture "$AGENT_NAME" \
        "Compute 123+456 and reply with exactly: RESULT=<answer>" \
        '{"modelProviderType":"anthropic-api-key","realAgentInPreview":true}'

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=579"
}

# Test 2: Structured run options — verify the guest-agent → Claude pipeline.
#
# Verifies:
#   - disallowedTools reaches Claude
#   - appendSystemPrompt reaches Claude (SIGNATURE in response)
@test "t27-2: run with append-system-prompt and disallowed-tools" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi

    ensure_anthropic_model_provider

    run run_compose_fixture "${AGENT_NAME}-flags" \
        "Compute 789+101 and follow the required final response format." \
        '{
            "modelProviderType":"anthropic-api-key",
            "realAgentInPreview":true,
            "appendSystemPrompt":"In your final response, output exactly two lines and no extra text. Line 1: RESULT=<answer>. Line 2: SIGNATURE=smoke-test.",
            "disallowedTools":["CronCreate","CronList","CronDelete"]
        }'

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=890"
    # Verify appendSystemPrompt reached Claude (agent follows the instruction).
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

    run run_compose_fixture "${AGENT_NAME}-settings" \
        "Step 1: run 'echo hello'. Step 2: run 'cat /tmp/hook_sentinel.txt'. Include the exact output of step 2 in your response." \
        "$(jq -nc --arg settings "$settings" \
            '{
                modelProviderType: "anthropic-api-key",
                realAgentInPreview: true,
                settings: $settings
            }')"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    # Sentinel file was created by PreToolUse hook and read by Claude
    assert_output --partial "SETTINGS_HOOK_OK"
}
