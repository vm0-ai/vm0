#!/usr/bin/env bats

# Real Claude BYOK smoke test through supported model, agent, chat, and usage APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-real-claude.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test

    export RUNNER_AGENT_ID
    RUNNER_AGENT_ID="$(create_runner_agent \
        "e2e-real-claude-$(date +%s%3N)-$RANDOM")"
    AGENT_ID="$RUNNER_AGENT_ID"
    set_runner_agent_instructions \
        "$RUNNER_AGENT_ID" \
        "Real Claude smoke test instructions."
}

teardown() {
    runner_e2e_teardown_test
}

wait_for_real_claude_events() {
    local run_id="$1"
    local timeout="${2:-30}"
    local interval="${RUNNER_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl \
            "/api/zero/runs/$run_id/telemetry/agent?limit=100&order=asc" \
            2>&1)"; then
            if jq -e '
                [.events[]?.eventData |
                    . as $eventData |
                    if type == "string" then
                        try fromjson catch $eventData
                    else
                        .
                    end
                ] as $payloads |
                .framework == "claude-code" and
                any($payloads[];
                    type == "object" and
                    .type == "result" and
                    .subtype == "success"
                )
            ' <<< "$response" >/dev/null; then
                printf '%s\n' "$response"
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for real Claude events for run $run_id" >&2
    echo "# Last event response: $response" >&2
    return 1
}

run_real_claude_chat() {
    local prompt="$1"
    local expected_output="$2"
    local send_response run_id thread_id run_response events_response

    send_response="$(runner_chat_send \
        "$RUNNER_AGENT_ID" \
        "$prompt" \
        "" \
        "claude-sonnet-5")" || return 1
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' \
        <<< "$send_response")" || return 1
    thread_id="$(jq -er '.threadId | select(type == "string" and length > 0)' \
        <<< "$send_response")" || return 1

    run_response="$(runner_wait_for_run "$run_id" 150)" || return 1
    _wait_for_runner_chat_output \
        "$thread_id" \
        "$run_id" \
        "$expected_output" \
        30 || return 1
    events_response="$(wait_for_real_claude_events "$run_id")" || return 1

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$thread_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        --arg framework "$(jq -er '.framework' <<< "$events_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            sessionId: $sessionId,
            framework: $framework,
            status: "completed"
        }'
    jq -r '.events[].eventData |
        if type == "string" then . else tojson end
    ' <<< "$events_response"
}

@test "t27-1: real claude BYOK returns an answer without vm0 usage" {
    run run_real_claude_chat \
        "123+456. Reply only RESULT=<answer>." \
        "RESULT=579"

    assert_success
    assert_output --partial '"framework":"claude-code"'
    assert_output --partial "RESULT=579"
    assert_output --partial '"type":"result"'
    assert_output --partial '"subtype":"success"'
    local run_id thread_id
    run_id="$(runner_chat_field "$output" '.runId')"
    thread_id="$(runner_chat_field "$output" '.threadId')"
    RUN_ID="$run_id"
    THREAD_ID="$thread_id"
    [[ -n "$run_id" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]

    run runner_e2e_assert_no_usage_for_thread "$thread_id" "$run_id"
    echo "$output"
    assert_success
    assert_output --partial '"vm0UsageCredits":0'
}
