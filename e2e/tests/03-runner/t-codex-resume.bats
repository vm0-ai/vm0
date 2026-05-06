#!/usr/bin/env bats

# Codex resume test — verifies vm0 run continue resumes a codex thread
# via the framework-aware checkpoint scan path.
#
# The first turn writes a session file at
# `$CODEX_HOME/sessions/YYYY/MM/DD/<thread_id>.jsonl.zst`. Continue
# rehydrates from the agent session, calls codex with `exec resume`, and
# the mock-codex appends another turn to the same file.

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
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Codex resume test agent"
    framework: codex
    environment:
      OPENAI_API_KEY: "\${{ secrets.OPENAI_API_KEY }}"
    volumes:
      - codex-files:/home/user/.codex
    working_dir: /home/user/workspace
volumes:
  codex-files:
    name: $VOLUME_NAME
    version: latest
EOF

    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t-codex-resume-1: continue resumes codex thread from session" {
    # Initial turn: creates a codex thread and writes the session file.
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "OPENAI_API_KEY=mock-not-validated-by-mock-codex" \
        "first turn"
    assert_success
    assert_output --partial "▷ Codex Started"
    assert_output --partial "● first turn"
    assert_output --partial "◆ Codex Completed"

    # The renderRunCompleted block prints the agent session UUID as the
    # last "Session:" line; the init event prints the codex thread_id
    # earlier (a different UUID). Use tail -1 to pick the agent session.
    local session_id
    session_id=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | tail -1)
    [ -n "$session_id" ] || {
        echo "# Failed to extract agent session id"
        echo "$output"
        return 1
    }
    echo "# Agent session: $session_id"

    # Continue the run: framework-aware restore_session resolves the
    # codex thread_id from the prior session, mock-codex appends to the
    # existing session file, and a new turn renders.
    run $VM0_CLI run continue "$session_id" \
        --secrets "OPENAI_API_KEY=mock-not-validated-by-mock-codex" \
        "second turn"
    assert_success
    assert_output --partial "▷ Codex Started"
    assert_output --partial "● second turn"
    assert_output --partial "◆ Codex Completed"
}
