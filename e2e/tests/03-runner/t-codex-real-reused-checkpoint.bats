#!/usr/bin/env bats

# Real Codex regression test for restoring an older checkpoint into a reused
# sandbox. The first rollout is deliberately created on a local calendar date
# that differs from UTC. This catches restore code that reconstructs a UTC path
# instead of asking Codex for the path it already indexed.

load '../../helpers/setup'

select_codex_test_timezone() {
    local utc_hour
    utc_hour="$(date -u +%H)"
    if (( 10#$utc_hour < 12 )); then
        printf '%s' "Etc/GMT+12"
    else
        printf '%s' "Pacific/Kiritimati"
    fi
}

seed_real_codex_agent() {
    local agent_name="$1" timezone="$2"
    local config="$TEST_DIR/${agent_name}.yaml"
    cat > "$config" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "Real Codex reused-checkpoint path regression test"
    framework: codex
    environment:
      OPENAI_MODEL: "gpt-5.4-mini"
      TZ: "${timezone}"
EOF
    seed_compose_fixture "$config" >/dev/null
}

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-real-codex-reused-${UNIQUE_ID}"
    export FIRST_MEMORY_TOKEN="first-${UNIQUE_ID}"
    export SECOND_MEMORY_TOKEN="second-${UNIQUE_ID}"
    export CODEX_TEST_TIMEZONE="$(select_codex_test_timezone)"

    configure_e2e_model_provider "openai-api-key" "$OPENAI_API_KEY"
    seed_real_codex_agent "$AGENT_NAME" "$CODEX_TEST_TIMEZONE"
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

@test "real Codex restores an older checkpoint at Codex's indexed rollout path" {
    ensure_openai_model_provider

    local overrides
    overrides='{"modelProviderType":"openai-api-key","realAgentInPreview":true}'

    local first_prompt
    first_prompt="$(printf '%s\n' \
        "Remember this exact first memory token for later: ${FIRST_MEMORY_TOKEN}" \
        "Use the shell tool to execute this exact script as one command:" \
        'set -eu' \
        'path=$(find /home/user/.codex/sessions -type f -name '\''rollout-*.jsonl'\'' | head -n 1)' \
        'test -n "$path"' \
        'base=${path##*/}' \
        'path_date=${base#rollout-}' \
        'path_date=${path_date%%T*}' \
        'utc_timestamp=$(head -n 1 "$path" | jq -er '\''.payload.timestamp // .timestamp'\'')' \
        'utc_date=${utc_timestamp%%T*}' \
        'printf '\''%s\n'\'' "$path" > /home/user/.codex/vm0-e2e-rollout-path' \
        'if [ "$path_date" = "$utc_date" ]; then path_diff=0; else path_diff=1; fi' \
        'printf '\''CODEX_LOCAL_DATE_PATH_RECORDED=%s\n'\'' "$path_diff"' \
        'After the command succeeds, reply with exactly FIRST_MEMORY_STORED.')"

    run run_compose_fixture "$AGENT_NAME" "$first_prompt" "$overrides"
    assert_success
    assert_output --partial "FIRST_MEMORY_STORED"

    # A run queued across the selected timezone's UTC date boundary can land
    # on the same calendar date. Recompute once with a fresh agent; if TZ was
    # ignored rather than a boundary being crossed, the assertion still fails.
    if [[ "$output" != *"CODEX_LOCAL_DATE_PATH_RECORDED=1"* ]]; then
        export AGENT_NAME="e2e-real-codex-reused-retry-${UNIQUE_ID}"
        export CODEX_TEST_TIMEZONE="$(select_codex_test_timezone)"
        seed_real_codex_agent "$AGENT_NAME" "$CODEX_TEST_TIMEZONE"

        run run_compose_fixture "$AGENT_NAME" "$first_prompt" "$overrides"
        assert_success
        assert_output --partial "FIRST_MEMORY_STORED"
    fi
    assert_output --partial "CODEX_LOCAL_DATE_PATH_RECORDED=1"

    local checkpoint_id session_id
    checkpoint_id="$(run_fixture_field "$output" '.checkpointId')"
    session_id="$(run_fixture_field "$output" '.sessionId')"
    [ -n "$checkpoint_id" ]
    [ -n "$session_id" ]

    run continue_run_fixture "$session_id" \
        "Remember this exact second memory token: ${SECOND_MEMORY_TOKEN}. Reply with exactly SECOND_MEMORY_STORED." \
        "$overrides"
    assert_success
    assert_output --partial "SECOND_MEMORY_STORED"

    local continued_run_id
    continued_run_id="$(run_fixture_field "$output" '.runId')"
    assert_run_reused_sandbox "$continued_run_id"

    local resume_prompt
    resume_prompt="$(printf '%s\n' \
        'Use the shell tool to execute this exact script as one command:' \
        'set -eu' \
        'path=$(cat /home/user/.codex/vm0-e2e-rollout-path)' \
        'if [ -f "$path" ]; then true; elif [ -f "$path.zst" ]; then true; else exit 1; fi' \
        'echo CODEX_RESTORED_AT_RECORDED_PATH' \
        'Then report the exact first memory token from this conversation as FIRST=<token>.' \
        'If this conversation contains a second memory token from a later turn, report it as SECOND=<token>; otherwise report SECOND=UNKNOWN.')"

    run resume_run_fixture "$checkpoint_id" "$resume_prompt" "$overrides"
    assert_success
    assert_output --partial "CODEX_RESTORED_AT_RECORDED_PATH"
    assert_output --partial "FIRST=${FIRST_MEMORY_TOKEN}"
    assert_output --partial "SECOND=UNKNOWN"
    refute_output --partial "$SECOND_MEMORY_TOKEN"

    local resumed_run_id
    resumed_run_id="$(run_fixture_field "$output" '.runId')"
    assert_run_reused_sandbox "$resumed_run_id"
}
