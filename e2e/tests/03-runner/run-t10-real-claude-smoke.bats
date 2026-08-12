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

run_real_claude_chat() {
    local prompt="$1"
    local expected_output="$2"
    local send_response run_id thread_id run_response chat_output

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
    chat_output="$(_wait_for_runner_chat_completion \
        "$thread_id" \
        "$run_id" \
        30)" || return 1
    if [[ "$chat_output" != *"$expected_output"* ]]; then
        echo "# Completed chat output did not contain ${expected_output@Q}: $chat_output" >&2
        return 1
    fi

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$thread_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            sessionId: $sessionId,
            status: "completed"
        }'
    printf '%s\n' "$chat_output"
}

run_real_claude_steer() {
    local steer_prompt="$1"
    local after_complete_prompt="$2"
    local initial_prompt='Run `sleep 10` with Bash, then read the follow-up message received during this run. Reply only RESULT=claude-initial-5k2+FOLLOWUP, replacing FOLLOWUP with its exact text. If no follow-up is received, reply only RESULT=missing.'
    local expected_output="RESULT=claude-initial-5k2+$steer_prompt"
    local after_complete_output="RESULT=claude-after-complete+$after_complete_prompt"
    local steer_result run_id thread_id steer_output successor_result
    local successor_run_id successor_output

    steer_result="$(runner_chat_steer \
        "$RUNNER_AGENT_ID" \
        "$initial_prompt" \
        "$steer_prompt" \
        "claude-sonnet-4-6" \
        "$expected_output" \
        150)" || return 1
    run_id="$(jq -er '.runId' <<< "$steer_result")" || return 1
    thread_id="$(jq -er '.threadId' <<< "$steer_result")" || return 1
    steer_output="$(_wait_for_runner_chat_completion \
        "$thread_id" \
        "$run_id" \
        45)" || return 1
    successor_result="$(runner_chat_send_after_completion \
        "$RUNNER_AGENT_ID" \
        "$thread_id" \
        "$run_id" \
        "Reply only $after_complete_output" \
        "$after_complete_output" \
        150)" || return 1
    successor_run_id="$(jq -er '.runId' <<< "$successor_result")" || return 1
    successor_output="$(_wait_for_runner_chat_completion \
        "$thread_id" \
        "$successor_run_id" \
        45)" || return 1

    jq -c \
        --arg successorRunId "$successor_run_id" \
        --arg successorThreadId "$(jq -er '.threadId' <<< "$successor_result")" \
        --arg successorSessionId "$(jq -er '.sessionId' <<< "$successor_result")" \
        '. + {
            successorRunId: $successorRunId,
            successorThreadId: $successorThreadId,
            successorSessionId: $successorSessionId
        }' \
        <<< "$steer_result"
    printf '%s\n%s\n' "$steer_output" "$successor_output"
}

@test "real claude returns a successful answer" {
    run run_real_claude_chat \
        "123+456. Reply only RESULT=<answer>." \
        "RESULT=579"

    assert_success
    assert_output --partial '"status":"completed"'
    assert_output --partial "RESULT=579"
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

@test "real claude steers an active run then starts a successor" {
    local steer_nonce steer_prompt after_complete_nonce after_complete_prompt
    steer_nonce="$(_runner_uuid)"
    steer_prompt="claude-steer-${steer_nonce%%-*}"
    after_complete_nonce="$(_runner_uuid)"
    after_complete_prompt="claude-new-run-${after_complete_nonce%%-*}"

    run run_real_claude_steer "$steer_prompt" "$after_complete_prompt"

    assert_success
    assert_output --partial "RESULT=claude-initial-5k2+$steer_prompt"
    assert_output --partial "RESULT=claude-after-complete+$after_complete_prompt"
    assert_output --partial '"status":"completed"'
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
