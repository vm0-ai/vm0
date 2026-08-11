#!/usr/bin/env bash

runner_api_token() {
    if [[ -z "${E2E_API_TOKEN:-}" ]]; then
        echo "E2E_API_TOKEN is required" >&2
        return 1
    fi
    printf '%s' "$E2E_API_TOKEN"
}

runner_api_url() {
    if [[ -z "${E2E_API_URL:-}" ]]; then
        echo "E2E_API_URL is required" >&2
        return 1
    fi
    printf '%s' "${E2E_API_URL%/}"
}

require_runner_api_credentials() {
    runner_api_token >/dev/null && runner_api_url >/dev/null
}

runner_api_curl() {
    local path="$1"
    shift

    local token base
    token="$(runner_api_token)" || return 1
    base="$(runner_api_url)" || return 1

    local -a headers=(
        -H "Authorization: Bearer $token"
        -H "Content-Type: application/json"
    )
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers+=(
            -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"
        )
    fi

    curl -fsS \
        --connect-timeout "${E2E_CURL_CONNECT_TIMEOUT_SECONDS:-10}" \
        --max-time "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
        "${headers[@]}" \
        "$@" \
        "$base$path"
}

create_runner_agent() {
    local display_name="$1"
    local payload response

    payload="$(jq -nc \
        --arg displayName "$display_name" \
        '{displayName: $displayName, visibility: "private"}')"
    response="$(runner_api_curl "/api/zero/agents" -X POST -d "$payload")" || return 1
    jq -er '.agentId | select(type == "string" and length > 0)' <<< "$response"
}

set_runner_agent_instructions() {
    local agent_id="$1"
    local content="$2"
    local payload

    payload="$(jq -nc --arg content "$content" '{content: $content}')"
    runner_api_curl "/api/zero/agents/$agent_id/instructions" \
        -X PUT \
        -d "$payload" \
        >/dev/null
}

delete_runner_agent() {
    local agent_id="$1"
    runner_api_curl "/api/zero/agents/$agent_id" -X DELETE >/dev/null
}

_runner_uuid() {
    tr -d '\n' < /proc/sys/kernel/random/uuid
}

runner_chat_send() {
    local agent_id="$1"
    local prompt="$2"
    local thread_id="$3"
    local selected_model="$4"
    local parts

    parts="$(jq -nc --arg prompt "$prompt" '[{type: "text", text: $prompt}]')"
    runner_chat_send_parts \
        "$agent_id" \
        "$prompt" \
        "$parts" \
        "$thread_id" \
        "$selected_model"
}

runner_chat_send_parts() {
    local agent_id="$1"
    local prompt="$2"
    local parts="$3"
    local thread_id="$4"
    local selected_model="$5"
    local client_event_id payload

    client_event_id="$(_runner_uuid)"
    if [[ -n "$thread_id" ]]; then
        payload="$(jq -nc \
            --arg agentId "$agent_id" \
            --arg prompt "$prompt" \
            --arg threadId "$thread_id" \
            --arg clientEventId "$client_event_id" \
            --argjson parts "$parts" \
            '{
                agentId: $agentId,
                prompt: $prompt,
                threadId: $threadId,
                clientEventId: $clientEventId,
                userMessage: {version: 1, parts: $parts},
                hasTextContent: true
            }')"
    else
        payload="$(jq -nc \
            --arg agentId "$agent_id" \
            --arg prompt "$prompt" \
            --arg model "$selected_model" \
            --arg clientEventId "$client_event_id" \
            --argjson parts "$parts" \
            '{
                agentId: $agentId,
                prompt: $prompt,
                model: $model,
                clientEventId: $clientEventId,
                userMessage: {version: 1, parts: $parts},
                hasTextContent: true
            }')"
    fi

    runner_api_curl "/api/zero/chat/events" -X POST -d "$payload"
}

runner_wait_for_run() {
    local run_id="$1"
    local timeout="${2:-100}"
    local interval="${RUNNER_RUN_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response="" run_status=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/zero/runs/$run_id" 2>&1)"; then
            run_status="$(jq -r '.status // empty' <<< "$response")"
            case "$run_status" in
                completed)
                    printf '%s\n' "$response"
                    return 0
                    ;;
                failed|timeout|cancelled)
                    echo "# Run $run_id reached terminal status: $run_status" >&2
                    echo "# Run response: $response" >&2
                    return 1
                    ;;
            esac
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for run $run_id" >&2
    echo "# Last run response: $response" >&2
    return 1
}

_wait_for_runner_chat_output() {
    local thread_id="$1"
    local run_id="$2"
    local prompt="$3"
    local timeout="${4:-30}"
    local interval="${RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/zero/chat-threads/$thread_id/events?limit=50" 2>&1)"; then
            if jq -e --arg runId "$run_id" --arg prompt "$prompt" '
                any(.events[]?;
                    .eventType == "output.message" and
                    .runId == $runId and
                    (.content | contains($prompt))
                ) and
                any(.events[]?;
                    .eventType == "run.completed" and .runId == $runId
                )
            ' <<< "$response" >/dev/null; then
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for chat output for run $run_id" >&2
    echo "# Last chat event response: $response" >&2
    return 1
}

_wait_for_runner_chat_completion() {
    local thread_id="$1"
    local run_id="$2"
    local timeout="${3:-30}"
    local interval="${RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""
    local output_message=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/zero/chat-threads/$thread_id/events?limit=50" 2>&1)" &&
            output_message="$(jq -er --arg runId "$run_id" '
                [
                    .events[]?
                    | select(
                        .eventType == "output.message" and
                        .runId == $runId
                    )
                    | .content
                    | select(type == "string" and test("\\S"))
                ]
                | last // empty
            ' <<< "$response")" &&
            jq -e --arg runId "$run_id" '
                any(.events[]?;
                    .eventType == "run.completed" and .runId == $runId
                )
            ' <<< "$response" >/dev/null; then
            printf '%s\n' "$output_message"
            return 0
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for completed chat output for run $run_id" >&2
    echo "# Last chat event response: $response" >&2
    return 1
}

_wait_for_runner_codex_events() {
    local run_id="$1"
    local prompt="$2"
    local timeout="${3:-30}"
    local interval="${RUNNER_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/zero/runs/$run_id/telemetry/agent?limit=100&order=asc" 2>&1)"; then
            if jq -e --arg prompt "$prompt" '
                [.events[]?.eventData |
                    if type == "string" then . else tojson end
                ] as $payloads |
                .framework == "codex" and
                any($payloads[]; contains("thread.started")) and
                any($payloads[]; contains("turn.completed")) and
                any($payloads[]; contains($prompt))
            ' <<< "$response" >/dev/null; then
                printf '%s\n' "$response"
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for Codex events for run $run_id" >&2
    echo "# Last event response: $response" >&2
    return 1
}

_runner_chat_execute() {
    local agent_id="$1"
    local prompt="$2"
    local thread_id="$3"
    local selected_model="$4"
    local send_response run_id resolved_thread_id run_response events_response

    send_response="$(runner_chat_send \
        "$agent_id" \
        "$prompt" \
        "$thread_id" \
        "$selected_model")" || return 1
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' <<< "$send_response")" || return 1
    resolved_thread_id="$(jq -er '.threadId | select(type == "string" and length > 0)' <<< "$send_response")" || return 1

    run_response="$(runner_wait_for_run "$run_id")" || return 1
    if ! jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<< "$run_response" >/dev/null; then
        echo "# Completed run did not contain a session id: $run_response" >&2
        return 1
    fi

    _wait_for_runner_chat_output \
        "$resolved_thread_id" \
        "$run_id" \
        "$prompt" || return 1
    events_response="$(_wait_for_runner_codex_events "$run_id" "$prompt")" || return 1

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$resolved_thread_id" \
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

runner_chat_start() {
    local agent_id="$1"
    local prompt="$2"
    _runner_chat_execute "$agent_id" "$prompt" "" "deepseek-v4-flash"
}

runner_chat_continue() {
    local agent_id="$1"
    local thread_id="$2"
    local prompt="$3"
    _runner_chat_execute "$agent_id" "$prompt" "$thread_id" ""
}

runner_chat_field() {
    local captured_output="$1"
    local filter="$2"
    sed -n '1p' <<< "$captured_output" | jq -er "$filter"
}
