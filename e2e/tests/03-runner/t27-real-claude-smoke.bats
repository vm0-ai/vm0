#!/usr/bin/env bats

# Real Claude BYOK smoke test through supported model, agent, chat, and usage APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

BATS_TEST_TIMEOUT=600

setup_file() {
    local credentials="/tmp/e2e-api-credentials-runner-real-claude.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment

    export RUNNER_AGENT_ID
    RUNNER_AGENT_ID="$(create_runner_agent \
        "e2e-real-claude-$(date +%s%3N)-$RANDOM")"
    set_runner_agent_instructions \
        "$RUNNER_AGENT_ID" \
        "Real Claude smoke test instructions."
}

teardown_file() {
    if [[ -n "${RUNNER_AGENT_ID:-}" ]]; then
        delete_runner_agent "$RUNNER_AGENT_ID"
    fi
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
        "claude-sonnet-4-6")" || return 1
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

run_real_claude_steer() {
    local steer_prompt="$1"
    local after_complete_prompt="$2"
    local initial_prompt='Run `sleep 10` with Bash, then read the follow-up message received during this run. Reply only RESULT=claude-initial-5k2+FOLLOWUP, replacing FOLLOWUP with its exact text. If no follow-up is received, reply only RESULT=missing.'
    local expected_output="RESULT=claude-initial-5k2+$steer_prompt"
    local after_complete_output="RESULT=claude-after-complete+$after_complete_prompt"
    local steer_result run_id events_response successor_result successor_run_id successor_events_response

    steer_result="$(runner_chat_steer \
        "$RUNNER_AGENT_ID" \
        "$initial_prompt" \
        "$steer_prompt" \
        "claude-sonnet-4-6" \
        "$expected_output" \
        150)" || return 1
    run_id="$(jq -er '.runId' <<< "$steer_result")" || return 1
    events_response="$(wait_for_real_claude_events "$run_id" 45)" || return 1
    successor_result="$(runner_chat_send_after_completion \
        "$RUNNER_AGENT_ID" \
        "$(jq -er '.threadId' <<< "$steer_result")" \
        "$run_id" \
        "Reply only $after_complete_output" \
        "$after_complete_output" \
        150)" || return 1
    successor_run_id="$(jq -er '.runId' <<< "$successor_result")" || return 1
    successor_events_response="$(wait_for_real_claude_events \
        "$successor_run_id" \
        45)" || return 1

    jq -c \
        --arg framework "$(jq -er '.framework' <<< "$events_response")" \
        --arg successorRunId "$successor_run_id" \
        --arg successorThreadId "$(jq -er '.threadId' <<< "$successor_result")" \
        --arg successorSessionId "$(jq -er '.sessionId' <<< "$successor_result")" \
        '. + {
            framework: $framework,
            successorRunId: $successorRunId,
            successorThreadId: $successorThreadId,
            successorSessionId: $successorSessionId
        }' \
        <<< "$steer_result"
    jq -r '.events[].eventData |
        if type == "string" then . else tojson end
    ' <<< "$events_response"
    jq -r '.events[].eventData |
        if type == "string" then . else tojson end
    ' <<< "$successor_events_response"
}

@test "t27-1: real claude returns a successful answer" {
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
    [[ -n "$run_id" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]

    run runner_e2e_assert_no_usage_for_thread "$thread_id" "$run_id"
    echo "$output"
    assert_success
    assert_output --partial '"vm0UsageCredits":0'
}

@test "t27-2: real claude steers an active run then starts a successor" {
    local steer_nonce steer_prompt after_complete_nonce after_complete_prompt
    steer_nonce="$(_runner_uuid)"
    steer_prompt="claude-steer-${steer_nonce%%-*}"
    after_complete_nonce="$(_runner_uuid)"
    after_complete_prompt="claude-new-run-${after_complete_nonce%%-*}"

    run run_real_claude_steer "$steer_prompt" "$after_complete_prompt"

    assert_success
    assert_output --partial '"framework":"claude-code"'
    assert_output --partial "RESULT=claude-initial-5k2+$steer_prompt"
    assert_output --partial "RESULT=claude-after-complete+$after_complete_prompt"
    assert_output --partial '"type":"result"'
    assert_output --partial '"subtype":"success"'
    [[ -n "$(runner_chat_field "$output" '.runId')" ]]
    [[ -n "$(runner_chat_field "$output" '.steerEventId')" ]]
    [[ -n "$(runner_chat_field "$output" '.sessionId')" ]]
    [[ -n "$(runner_chat_field "$output" '.successorRunId')" ]]
    [[ -n "$(runner_chat_field "$output" '.successorSessionId')" ]]
    [[ "$(runner_chat_field "$output" '.successorRunId')" != \
        "$(runner_chat_field "$output" '.runId')" ]]
    [[ "$(runner_chat_field "$output" '.successorThreadId')" == \
        "$(runner_chat_field "$output" '.threadId')" ]]
}
