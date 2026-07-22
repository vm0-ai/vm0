#!/usr/bin/env bats

# Codex resume test — verifies session continuation resumes a codex thread
# via the framework-aware checkpoint scan path.
#
# The first turn writes a mock session file at
# `$CODEX_HOME/sessions/YYYY/MM/DD/<thread_id>.jsonl`. Continue
# rehydrates from the agent session into Codex's rollout filename shape,
# calls codex with `exec resume`, and renders the next turn.

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-codex-resume-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    export VOLUME_NAME="e2e-codex-resume-vol-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > AGENTS.md << 'VOLEOF'
Codex resume test instructions.
VOLEOF
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Codex resume test agent"
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

@test "t-codex-resume-1: continue resumes codex thread from session" {
    # Initial turn: creates a codex thread and writes the first mock session file.
    run run_compose_fixture "$AGENT_NAME" "first turn"
    assert_success
    assert_output --partial "▷ Codex Started"
    assert_output --partial "● first turn"
    assert_output --partial "◆ Codex Completed"

    local session_id
    session_id=$(run_fixture_field "$output" '.sessionId')
    [ -n "$session_id" ] || {
        echo "# Failed to extract agent session id"
        echo "$output"
        return 1
    }
    echo "# Agent session: $session_id"

    # Continue the run: framework-aware restore_session resolves the
    # codex thread_id from the prior session, restores that history into
    # Codex's rollout filename shape, and the next turn renders.
    run continue_run_fixture "$session_id" "second turn"
    assert_success
    assert_output --partial "▷ Codex Started"
    assert_output --partial "● second turn"
    assert_output --partial "◆ Codex Completed"
}
