#!/usr/bin/env bats

# Real Codex smoke and vm0-managed usage attribution through public APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-codex.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "t28-1: real codex reports vm0-managed model usage" {
    run create_runner_agent "e2e-real-codex-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    run set_runner_agent_instructions \
        "$AGENT_ID" \
        "Real Codex billing smoke test instructions."
    echo "$output"
    assert_success

    local prompt="Briefly confirm that the real Codex runner is responding."
    run runner_chat_send "$AGENT_ID" "$prompt" "" "gpt-5.6-luna"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 60
    echo "$output"
    assert_success

    run _wait_for_runner_codex_events "$RUN_ID" "$prompt" 60
    echo "$output"
    assert_success
    local agent_events="$output"
    run jq -e '
        .framework == "codex" and
        any(.events[]?.eventData | tostring; contains("thread.started")) and
        any(.events[]?.eventData | tostring; contains("turn.completed"))
    ' <<<"$agent_events"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_usage_event \
        "$THREAD_ID" \
        "$RUN_ID" \
        "gpt-5.6-luna"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_usage_record "$THREAD_ID" "gpt-5.6-luna"
    echo "$output"
    assert_success
    local usage_record="$output"
    run jq -e --arg threadId "$THREAD_ID" '
        any(.rows[]?;
            .threadId == $threadId and
            .credits > 0 and
            .tokens > 0 and
            any(.breakdown[]?;
                .kind == "model" and
                any(.providers[]?;
                    .provider == "gpt-5.6-luna" and .credits > 0
                )
            )
        )
    ' <<<"$usage_record"
    echo "$output"
    assert_success
}
