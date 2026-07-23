#!/usr/bin/env bats

# Real Codex regression coverage for restoring an older checkpoint into a
# reused sandbox. The original rollout uses a civil date that differs from UTC,
# so a restored checkpoint must resume through the explicit path materialized
# by the runner rather than Codex's stale thread index.

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
    export AGENT_NAME="e2e-real-codex-reused-${UNIQUE_ID}"
    export FIRST_MEMORY_TOKEN="first-${UNIQUE_ID}"
    export SECOND_MEMORY_TOKEN="second-${UNIQUE_ID}"
    CODEX_TEST_TIMEZONE="$(select_codex_test_timezone)"
    export CODEX_TEST_TIMEZONE

    configure_e2e_model_provider "openai-api-key" "$OPENAI_API_KEY"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real Codex reused-checkpoint explicit-path regression test"
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

@test "real Codex restores an older checkpoint through the runner path" {
    ensure_openai_model_provider

    local overrides
    overrides='{"modelProviderType":"openai-api-key","realAgentInPreview":true}'

    local first_prompt
    first_prompt="$(printf '%s\n' \
        "Remember this exact first memory token for later: ${FIRST_MEMORY_TOKEN}" \
        "Use the shell tool to execute this exact script as one command:" \
        'set -eu' \
        "path=\$(find /home/user/.codex/sessions -type f -name 'rollout-*.jsonl' -printf '%T@ %p\\n' | sort -nr | head -n 1 | cut -d ' ' -f 2-)" \
        "test -n \"\$path\"" \
        "base=\${path##*/}" \
        "path_date=\${base#rollout-}" \
        "path_date=\${path_date%%T*}" \
        "utc_timestamp=\$(head -n 1 \"\$path\" | jq -er '.payload.timestamp // .timestamp')" \
        "utc_date=\${utc_timestamp%%T*}" \
        "thread_id=\$(head -n 1 \"\$path\" | jq -er 'select(.type == \"session_meta\") | .payload.id')" \
        "case \"\$path\" in *-\"\$thread_id\".jsonl) ;; *) exit 1 ;; esac" \
        "printf '%s\\n' \"\$path\" > /home/user/.codex/vm0-e2e-rollout-path" \
        "printf '%s\\n' \"\$thread_id\" > /home/user/.codex/vm0-e2e-thread-id" \
        "test \"\$path_date\" != \"\$utc_date\"" \
        'echo CODEX_LOCAL_DATE_PATH_RECORDED' \
        'After the command succeeds, reply with exactly FIRST_MEMORY_STORED.')"

    run run_compose_fixture "$AGENT_NAME" "$first_prompt" "$overrides"
    assert_success
    assert_output --partial "CODEX_LOCAL_DATE_PATH_RECORDED"
    assert_output --partial "FIRST_MEMORY_STORED"

    local checkpoint_id agent_session_id
    checkpoint_id="$(run_fixture_field "$output" '.checkpointId')"
    agent_session_id="$(run_fixture_field "$output" '.sessionId')"
    [ -n "$checkpoint_id" ]
    [ -n "$agent_session_id" ]

    run continue_run_fixture "$agent_session_id" \
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
        "original=\$(cat /home/user/.codex/vm0-e2e-rollout-path)" \
        "thread_id=\$(cat /home/user/.codex/vm0-e2e-thread-id)" \
        "case \"\$original\" in *-\"\$thread_id\".jsonl) ;; *) exit 1 ;; esac" \
        "test ! -e \"\$original\"" \
        "test ! -e \"\$original.zst\"" \
        "matches=\$(find /home/user/.codex/sessions -type f \\( -name \"rollout-*-\$thread_id.jsonl\" -o -name \"rollout-*-\$thread_id.jsonl.zst\" \\))" \
        "count=\$(printf '%s\\n' \"\$matches\" | sed '/^$/d' | wc -l)" \
        "test \"\$count\" -eq 1" \
        "restored=\$(printf '%s\\n' \"\$matches\" | head -n 1)" \
        "test \"\$restored\" != \"\$original\"" \
        'echo CODEX_EXPLICIT_RESTORE_PATH_VERIFIED' \
        'Then report the exact first memory token from this conversation as FIRST=<token>.' \
        'If this conversation contains a second memory token from a later turn, report it as SECOND=<token>; otherwise report SECOND=UNKNOWN.')"

    run resume_run_fixture "$checkpoint_id" "$resume_prompt" "$overrides"
    assert_success
    assert_output --partial "CODEX_EXPLICIT_RESTORE_PATH_VERIFIED"
    assert_output --partial "FIRST=${FIRST_MEMORY_TOKEN}"
    assert_output --partial "SECOND=UNKNOWN"
    assert_output --partial '"type":"turn.completed"'
    refute_output --partial "$SECOND_MEMORY_TOKEN"

    local resumed_run_id resumed_checkpoint_id
    resumed_run_id="$(run_fixture_field "$output" '.runId')"
    resumed_checkpoint_id="$(run_fixture_field "$output" '.checkpointId')"
    assert_run_reused_sandbox "$resumed_run_id"
    [ -n "$resumed_checkpoint_id" ]
    [ "$resumed_checkpoint_id" != "$checkpoint_id" ]
}
