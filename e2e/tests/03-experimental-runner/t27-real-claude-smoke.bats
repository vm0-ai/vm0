#!/usr/bin/env bats

# Real Claude smoke tests — verify actual LLM execution (not mock).
# These tests require ANTHROPIC_API_KEY and are skipped in normal CI.
#
# Test 1: cook path — API key passed as environment secret
# Test 2: run path — API key injected via org model-provider (production flow)

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use unique names with timestamp to avoid conflicts in parallel runs
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-real-claude-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-real-claude-art-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Helper: fail if ANTHROPIC_API_KEY is not set
require_api_key() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        fail "ANTHROPIC_API_KEY not set - required for real Claude test"
    fi
}

@test "real claude via cook with environment secret" {
    require_api_key

    cd "$TEST_DIR"

    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Real Claude smoke test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
EOF

    cat > .env <<EOF
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
EOF

    run timeout 120 $CLI_COMMAND cook --no-auto-update --debug-no-mock-claude \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "RESULT=579"
}

@test "real claude via run with model-provider injection" {
    require_api_key

    # Step 1: Set up model provider with real API key
    echo "# Setting up model provider..."
    run $CLI_COMMAND org model-provider setup \
        --type "anthropic-api-key" --secret "$ANTHROPIC_API_KEY"
    assert_success

    # Step 2: Create agent config (no manual secrets — model provider handles it)
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Real Claude via model-provider"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Step 3: Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Run with --debug-no-mock-claude (model provider injects credential via proxy)
    echo "# Running agent with model-provider..."
    run timeout 120 $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --debug-no-mock-claude \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "RESULT=579"

    # Step 5: Clean up model provider
    $CLI_COMMAND org model-provider remove "anthropic-api-key" 2>/dev/null || true
}
