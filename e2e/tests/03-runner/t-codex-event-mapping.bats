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
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Codex event-mapping fixture-driver agent"
    framework: codex
    environment:
      OPENAI_API_KEY: ""
      MOCK_CODEX_FIXTURE: "\${{ vars.MOCK_CODEX_FIXTURE }}"
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

@test "t-codex-event-mapping-1: rich fixture exposes all item types" {
    run run_compose_fixture "$AGENT_NAME" \
        "drive the rich fixture" \
        '{"vars":{"MOCK_CODEX_FIXTURE":"event-mapping-rich"}}'

    assert_success
    # thread.started -> init
    assert_output --partial '"type":"thread.started"'
    assert_output --partial '"type":"command_execution"'
    assert_output --partial '"command":"echo hello"'
    assert_output --partial '"type":"file_edit"'
    assert_output --partial "/tmp/edit-target.txt"
    assert_output --partial '"type":"file_read"'
    assert_output --partial "/tmp/read-target.txt"
    assert_output --partial '"kind":"add"'
    assert_output --partial "/tmp/created.txt"
    assert_output --partial '"kind":"modify"'
    assert_output --partial "/tmp/modified.txt"
    assert_output --partial '"kind":"delete"'
    assert_output --partial "/tmp/removed.txt"
    assert_output --partial "Considering the request before acting"
    assert_output --partial "Fixture event walkthrough complete"
    # turn.completed -> result
    assert_output --partial '"type":"turn.completed"'
}

@test "t-codex-event-mapping-2: turn-failed fixture exposes failure" {
    run run_compose_fixture "$AGENT_NAME" \
        "drive the turn-failed fixture" \
        '{"vars":{"MOCK_CODEX_FIXTURE":"turn-failed"}}'

    # The mock binary always exits 0; turn.failed is data-only, so the
    # run lifecycle status stays completed and the CLI exits success.
    # Failure is surfaced inside the rendered event stream.
    assert_output --partial '"type":"thread.started"'
    assert_output --partial "Attempting the turn"
    assert_output --partial '"type":"turn.failed"'
}

@test "t-codex-event-mapping-3: error-event fixture exposes failure" {
    run run_compose_fixture "$AGENT_NAME" \
        "drive the error-event fixture" \
        '{"vars":{"MOCK_CODEX_FIXTURE":"error-event"}}'

    assert_output --partial '"type":"thread.started"'
    assert_output --partial '"type":"error"'
    assert_output --partial "Mock error event for fixture testing"
}
