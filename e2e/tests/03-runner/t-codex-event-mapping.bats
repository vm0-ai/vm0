#!/usr/bin/env bats

# Codex event-mapping test — exercises codex-event-parser branches that
# the synthetic 3-event sequence cannot reach.
#
# Drives mock-codex into "fixture mode" (MOCK_CODEX_FIXTURE=<name>) so
# the binary emits a baked JSONL stream covering command_execution,
# file_edit, file_read, file_change, reasoning, turn.failed, and error
# events. Each fixture is checked into
# `crates/guest-mock-codex/fixtures/`.
#
# MOCK_CODEX_FIXTURE reaches the codex subprocess via compose
# environment expansion: declared as `${{ vars.MOCK_CODEX_FIXTURE }}`
# and supplied per-test with `--vars`. The runner injects compose env
# into the agent process; tokio Command inherits the parent env when
# spawning codex, so the mock binary observes the override.

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-codex-event-map-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    export VOLUME_NAME="e2e-codex-event-map-vol-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > AGENTS.md << 'VOLEOF'
Codex event-mapping fixture-driver instructions.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Codex event-mapping fixture-driver agent"
    framework: codex
    environment:
      OPENAI_API_KEY: "\${{ secrets.OPENAI_API_KEY }}"
      MOCK_CODEX_FIXTURE: "\${{ vars.MOCK_CODEX_FIXTURE }}"
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

@test "t-codex-event-mapping-1: rich fixture renders all item types" {
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "OPENAI_API_KEY=mock-not-validated-by-mock-codex" \
        --vars "MOCK_CODEX_FIXTURE=event-mapping-rich" \
        "drive the rich fixture"

    assert_success
    # thread.started -> init
    assert_output --partial "▷ Codex Started"
    # command_execution renders as Bash tool
    assert_output --partial "● Bash(echo hello)"
    # file_edit renders as Edit tool
    assert_output --partial "● Edit"
    assert_output --partial "/tmp/edit-target.txt"
    # file_read renders as Read tool
    assert_output --partial "● Read"
    assert_output --partial "/tmp/read-target.txt"
    # file_change renders as a [files] text block with kind labels
    assert_output --partial "[files]"
    assert_output --partial "Created: /tmp/created.txt"
    assert_output --partial "Modified: /tmp/modified.txt"
    assert_output --partial "Deleted: /tmp/removed.txt"
    # reasoning renders as a [thinking] text block
    assert_output --partial "[thinking] Considering the request before acting"
    # agent_message renders as plain text
    assert_output --partial "● Fixture event walkthrough complete"
    # turn.completed -> result
    assert_output --partial "◆ Codex Completed"
}

@test "t-codex-event-mapping-2: turn-failed fixture renders Codex Failed" {
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "OPENAI_API_KEY=mock-not-validated-by-mock-codex" \
        --vars "MOCK_CODEX_FIXTURE=turn-failed" \
        "drive the turn-failed fixture"

    # The mock binary always exits 0; turn.failed is data-only, so the
    # run lifecycle status stays completed and the CLI exits success.
    # Failure is surfaced inside the rendered event stream.
    assert_output --partial "▷ Codex Started"
    assert_output --partial "● Attempting the turn"
    assert_output --partial "◆ Codex Failed"
}

@test "t-codex-event-mapping-3: error-event fixture renders Codex Failed" {
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "OPENAI_API_KEY=mock-not-validated-by-mock-codex" \
        --vars "MOCK_CODEX_FIXTURE=error-event" \
        "drive the error-event fixture"

    assert_output --partial "▷ Codex Started"
    # error events parse to a failed result
    assert_output --partial "◆ Codex Failed"
}
