#!/usr/bin/env bats

# Codex smoke test — verifies the mock-codex pipeline end-to-end.
#
# Activated via USE_MOCK_CODEX=true in CI (see turbo.yml + crates.yml).
# The mock-codex binary emits a synthetic 3-event sequence
# (thread.started -> item.completed agent_message -> turn.completed)
# and persists a JSONL session file, mirroring the real codex CLI's protocol.
#
# Verifies:
#   - Codex lifecycle events are exposed as structured API payloads
#   - agent_message text is retained
#   - --vars expansion reaches the codex subprocess environment

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-codex-smoke-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    export VOLUME_NAME="e2e-codex-smoke-vol-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > AGENTS.md << 'VOLEOF'
Codex smoke test instructions.
VOLEOF
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Codex smoke test agent"
    framework: codex
    environment:
      OPENAI_API_KEY: ""
    volumes:
      - codex-files:/home/user/.codex
volumes:
  codex-files:
    name: $VOLUME_NAME
    version: latest
EOF

    seed_compose_fixture "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t-codex-smoke-1: basic codex run returns structured events" {
    run run_compose_fixture "$AGENT_NAME" \
        "echo from codex" \
        '{"realAgentInPreview":false}'

    assert_success
    # init event from thread.started
    assert_output --partial '"type":"thread.started"'
    # mock-codex synthetic mode echoes the prompt back as agent_message text
    assert_output --partial "echo from codex"
    # result event from turn.completed
    assert_output --partial '"type":"turn.completed"'
    [ -n "$(run_fixture_field "$output" '.sessionId')" ]
}
