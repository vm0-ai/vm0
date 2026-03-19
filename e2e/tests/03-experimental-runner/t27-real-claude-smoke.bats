#!/usr/bin/env bats

# Real Claude smoke test — verify actual LLM execution (not mock).
# Requires ANTHROPIC_API_KEY set in CI via secrets.CI_ANTHROPIC_API_KEY.
#
# Tests two auth paths sequentially in a single test to avoid parallel
# conflicts (model-provider setup/remove is org-level shared state):
#   1. cook path — API key passed as environment secret
#   2. run path — API key injected via org model-provider (production flow)

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-real-claude-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-real-claude-art-${UNIQUE_ID}"
}

teardown() {
    # Clean up model provider (best-effort)
    $CLI_COMMAND org model-provider remove "anthropic-api-key" 2>/dev/null || true
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "real claude: cook with env secret and run with model-provider" {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        fail "ANTHROPIC_API_KEY not set - required for real Claude test"
    fi

    # -- Part 1: cook path (API key as environment secret) --
    echo "# Part 1: cook with environment secret..."
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

    # -- Part 2: run path (model-provider injects credential via proxy) --
    echo "# Part 2: run with model-provider injection..."

    $CLI_COMMAND org model-provider setup \
        --type "anthropic-api-key" --secret "$ANTHROPIC_API_KEY"

    cat > "$TEST_DIR/run-vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-mp:
    description: "Real Claude via model-provider"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    $CLI_COMMAND compose "$TEST_DIR/run-vm0.yaml"

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    run timeout 120 $CLI_COMMAND run "${AGENT_NAME}-mp" \
        --artifact-name "$ARTIFACT_NAME" \
        --model-provider "anthropic-api-key" \
        --debug-no-mock-claude \
        "Compute 789+101 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "RESULT=890"
}
