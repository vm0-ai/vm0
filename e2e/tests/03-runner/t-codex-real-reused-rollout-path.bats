#!/usr/bin/env bats

# Real Codex regression coverage for restoring an older checkpoint at the
# rollout identity retained by a reused sandbox.

load '../../helpers/setup'

select_codex_test_timezone() {
    local utc_hour
    utc_hour="$(date -u +%H)"
    if (( 10#$utc_hour < 10 )); then
        printf '%s' "Etc/GMT+12"
    else
        printf '%s' "Pacific/Kiritimati"
    fi
}

setup_file() {
    UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export UNIQUE_ID
    TEST_DIR="$(mktemp -d)"
    export TEST_DIR
    export AGENT_NAME="e2e-real-codex-reused-path-${UNIQUE_ID}"
    CODEX_TEST_TIMEZONE="$(select_codex_test_timezone)"
    export CODEX_TEST_TIMEZONE

    configure_e2e_model_provider "openai-api-key" "$OPENAI_API_KEY"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real Codex reused rollout path regression test"
    framework: codex
    environment:
      OPENAI_MODEL: "gpt-5.4-mini"
      TZ: "${CODEX_TEST_TIMEZONE}"
EOF

    seed_compose_fixture "$TEST_DIR/vm0.yaml" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

ensure_openai_model_provider() {
    configure_e2e_model_provider "openai-api-key" "$OPENAI_API_KEY"
}

assert_run_reused_sandbox() {
    local run_id="$1" runner
    runner="$(e2e_api_curl "/api/zero/runs/$run_id/runner")"
    assert_equal "$(jq -r '.sandboxReuseResult' <<< "$runner")" "reused"
}

codex_thread_id_from_output() {
    local captured_output="$1"
    jq -Rr \
        'fromjson? | select(.type == "thread.started") | .thread_id // empty' \
        <<< "$captured_output"
}

@test "real Codex restores a checkpoint at the reused rollout path" {
    ensure_openai_model_provider

    local overrides
    overrides='{"modelProviderType":"openai-api-key","realAgentInPreview":true}'

    run run_compose_fixture "$AGENT_NAME" "Reply with exactly A." "$overrides"
    assert_success
    assert_output --partial '"type":"turn.completed"'

    local checkpoint_id vm0_session_id codex_thread_id
    checkpoint_id="$(run_fixture_field "$output" '.checkpointId')"
    vm0_session_id="$(run_fixture_field "$output" '.sessionId')"
    codex_thread_id="$(codex_thread_id_from_output "$output")"
    [ -n "$checkpoint_id" ]
    [ -n "$vm0_session_id" ]
    [ -n "$codex_thread_id" ]

    # Advance the live thread beyond checkpoint A so resume must restore it.
    run continue_run_fixture "$vm0_session_id" \
        "Reply with exactly B." \
        "$overrides"
    assert_success
    assert_equal "$(codex_thread_id_from_output "$output")" "$codex_thread_id"
    assert_output --partial '"type":"turn.completed"'

    local continued_run_id
    continued_run_id="$(run_fixture_field "$output" '.runId')"
    assert_run_reused_sandbox "$continued_run_id"

    run resume_run_fixture "$checkpoint_id" "Reply with exactly C." "$overrides"
    assert_success
    assert_equal "$(codex_thread_id_from_output "$output")" "$codex_thread_id"
    assert_output --partial '"type":"turn.completed"'

    local resumed_run_id resumed_checkpoint_id resumed_vm0_session_id
    resumed_run_id="$(run_fixture_field "$output" '.runId')"
    resumed_checkpoint_id="$(run_fixture_field "$output" '.checkpointId')"
    resumed_vm0_session_id="$(run_fixture_field "$output" '.sessionId')"
    assert_run_reused_sandbox "$resumed_run_id"
    assert_equal "$resumed_vm0_session_id" "$vm0_session_id"
    [ -n "$resumed_checkpoint_id" ]
    [ "$resumed_checkpoint_id" != "$checkpoint_id" ]
}
