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
    if [[ -n "${CF_ACCESS_CLIENT_ID:-}" || -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
        if [[ -z "${CF_ACCESS_CLIENT_ID:-}" || -z "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
            echo "Cloudflare Access credentials must be configured together" >&2
            return 1
        fi
        headers+=(
            -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
            -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
        )
    fi
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
    response="$(runner_api_curl "/api/okou/agents" -X POST -d "$payload")" || return 1
    jq -er '.agentId | select(type == "string" and length > 0)' <<< "$response"
}

set_runner_agent_instructions() {
    local agent_id="$1"
    local content="$2"
    local payload

    payload="$(jq -nc --arg content "$content" '{content: $content}')"
    runner_api_curl "/api/okou/agents/$agent_id/instructions" \
        -X PUT \
        -d "$payload" \
        >/dev/null
}

delete_runner_agent() {
    local agent_id="$1"
    runner_api_curl "/api/okou/agents/$agent_id" -X DELETE >/dev/null
}

_runner_uuid() {
    tr -d '\n' < /proc/sys/kernel/random/uuid
}

runner_chat_send() {
    local agent_id="$1"
    local prompt="$2"
    local thread_id="$3"
    local selected_model="$4"
    local client_event_id="${5:-}"
    local capture_network_bodies="${6:-false}"
    local parts

    parts="$(jq -nc --arg prompt "$prompt" '[{type: "text", text: $prompt}]')"
    runner_chat_send_parts \
        "$agent_id" \
        "$prompt" \
        "$parts" \
        "$thread_id" \
        "$selected_model" \
        "$client_event_id" \
        "$capture_network_bodies"
}

runner_chat_send_parts() {
    local agent_id="$1"
    local prompt="$2"
    local parts="$3"
    local thread_id="$4"
    local selected_model="$5"
    local client_event_id="${6:-}"
    local capture_network_bodies="${7:-false}"
    local payload

    if [[ -z "$client_event_id" ]]; then
        client_event_id="$(_runner_uuid)"
    fi
    if [[ -n "$thread_id" ]]; then
        payload="$(jq -nc \
            --arg agentId "$agent_id" \
            --arg prompt "$prompt" \
            --arg threadId "$thread_id" \
            --arg clientEventId "$client_event_id" \
            --argjson parts "$parts" \
            --argjson captureNetworkBodies "$capture_network_bodies" \
            '{
                agentId: $agentId,
                prompt: $prompt,
                threadId: $threadId,
                clientEventId: $clientEventId,
                userMessage: {version: 1, parts: $parts},
                hasTextContent: true
            } + if $captureNetworkBodies then {captureNetworkBodies: true} else {} end')"
    else
        payload="$(jq -nc \
            --arg agentId "$agent_id" \
            --arg prompt "$prompt" \
            --arg model "$selected_model" \
            --arg clientEventId "$client_event_id" \
            --argjson parts "$parts" \
            --argjson captureNetworkBodies "$capture_network_bodies" \
            '{
                agentId: $agentId,
                prompt: $prompt,
                model: $model,
                clientEventId: $clientEventId,
                userMessage: {version: 1, parts: $parts},
                hasTextContent: true
            } + if $captureNetworkBodies then {captureNetworkBodies: true} else {} end')"
    fi

    runner_api_curl "/api/okou/chat/events" -X POST -d "$payload"
}

runner_wait_for_run() {
    local run_id="$1"
    local timeout="${2:-100}"
    local interval="${RUNNER_RUN_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response="" run_status=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/okou/runs/$run_id" 2>&1)"; then
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

runner_wait_for_run_running() {
    local run_id="$1"
    local timeout="${2:-60}"
    local interval="${RUNNER_RUN_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response="" run_status=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/okou/runs/$run_id" 2>&1)"; then
            run_status="$(jq -r '.status // empty' <<< "$response")"
            case "$run_status" in
                running)
                    printf '%s\n' "$response"
                    return 0
                    ;;
                completed|failed|timeout|cancelled)
                    echo "# Run $run_id reached terminal status before steer: $run_status" >&2
                    echo "# Run response: $response" >&2
                    return 1
                    ;;
            esac
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for run $run_id to start" >&2
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
        if response="$(runner_api_curl "/api/okou/chat-threads/$thread_id/events?limit=50" 2>&1)"; then
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
        if response="$(runner_api_curl "/api/okou/chat-threads/$thread_id/events?limit=50" 2>&1)" &&
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

_wait_for_runner_chat_steer_consumed() {
    local thread_id="$1"
    local run_id="$2"
    local steer_event_id="$3"
    local steer_prompt="$4"
    local expected_output="$5"
    local timeout="${6:-45}"
    local interval="${RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while (( SECONDS - start < timeout )); do
        if response="$(runner_api_curl "/api/okou/chat-threads/$thread_id/events?limit=50" 2>&1)"; then
            if jq -e \
                --arg runId "$run_id" \
                --arg steerEventId "$steer_event_id" \
                --arg steerPrompt "$steer_prompt" \
                --arg expectedOutput "$expected_output" '
                any(.events[]?;
                    .eventType == "input.prompt" and
                    .runId == $runId and
                    .revokesEventId == $steerEventId and
                    any(.userMessage.parts[]?;
                        .type == "text" and .text == $steerPrompt
                    )
                ) and
                any(.events[]?;
                    .eventType == "output.message" and
                    .runId == $runId and
                    (.content | contains($expectedOutput))
                ) and
                any(.events[]?;
                    .eventType == "run.completed" and .runId == $runId
                ) and
                all(.events[]?;
                    (.runId == null or .runId == $runId)
                )
            ' <<< "$response" >/dev/null; then
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for steer $steer_event_id to be consumed by run $run_id" >&2
    echo "# Last chat event response: $response" >&2
    return 1
}

runner_chat_steer() {
    local agent_id="$1"
    local initial_prompt="$2"
    local steer_prompt="$3"
    local selected_model="$4"
    local expected_output="$5"
    local run_timeout="${6:-180}"
    local send_response run_id thread_id steer_event_id steer_response run_response

    send_response="$(runner_chat_send \
        "$agent_id" \
        "$initial_prompt" \
        "" \
        "$selected_model")" || return 1
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' \
        <<< "$send_response")" || return 1
    thread_id="$(jq -er '.threadId | select(type == "string" and length > 0)' \
        <<< "$send_response")" || return 1

    runner_wait_for_run_running "$run_id" 60 >/dev/null || return 1

    steer_event_id="$(_runner_uuid)"
    steer_response="$(runner_chat_send \
        "$agent_id" \
        "$steer_prompt" \
        "$thread_id" \
        "" \
        "$steer_event_id")" || return 1
    if ! jq -e --arg threadId "$thread_id" '
        has("runId") and .runId == null and .threadId == $threadId
    ' <<< "$steer_response" >/dev/null; then
        echo "# Steer created a separate run or thread: $steer_response" >&2
        return 1
    fi

    run_response="$(runner_wait_for_run "$run_id" "$run_timeout")" || return 1
    if ! jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<< "$run_response" >/dev/null; then
        echo "# Completed steered run did not contain a session id: $run_response" >&2
        return 1
    fi

    _wait_for_runner_chat_steer_consumed \
        "$thread_id" \
        "$run_id" \
        "$steer_event_id" \
        "$steer_prompt" \
        "$expected_output" \
        45 || return 1

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$thread_id" \
        --arg steerEventId "$steer_event_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            steerEventId: $steerEventId,
            sessionId: $sessionId,
            status: "completed"
        }'
}

runner_chat_send_after_completion() {
    local agent_id="$1"
    local thread_id="$2"
    local completed_run_id="$3"
    local prompt="$4"
    local expected_output="$5"
    local run_timeout="${6:-180}"
    local send_response run_id run_response

    send_response="$(runner_chat_send \
        "$agent_id" \
        "$prompt" \
        "$thread_id" \
        "")" || return 1
    if ! jq -e \
        --arg threadId "$thread_id" \
        --arg completedRunId "$completed_run_id" '
        .threadId == $threadId and
        (.runId | type == "string" and length > 0) and
        .runId != $completedRunId
    ' <<< "$send_response" >/dev/null; then
        echo "# Post-completion message did not create a successor run: $send_response" >&2
        return 1
    fi
    run_id="$(jq -er '.runId' <<< "$send_response")" || return 1

    run_response="$(runner_wait_for_run "$run_id" "$run_timeout")" || return 1
    if ! jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<< "$run_response" >/dev/null; then
        echo "# Completed successor run did not contain a session id: $run_response" >&2
        return 1
    fi

    _wait_for_runner_chat_output \
        "$thread_id" \
        "$run_id" \
        "$expected_output" \
        45 || return 1

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
}

_runner_chat_execute() {
    local agent_id="$1"
    local prompt="$2"
    local thread_id="$3"
    local selected_model="$4"
    local send_response run_id resolved_thread_id run_response chat_output

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

    chat_output="$(_wait_for_runner_chat_completion \
        "$resolved_thread_id" \
        "$run_id")" || return 1
    if [[ "$chat_output" != *"$prompt"* ]]; then
        echo "# Completed chat output did not contain ${prompt@Q}: $chat_output" >&2
        return 1
    fi

    jq -cn \
        --arg runId "$run_id" \
        --arg threadId "$resolved_thread_id" \
        --arg sessionId "$(jq -er '.result.agentSessionId' <<< "$run_response")" \
        '{
            runId: $runId,
            threadId: $threadId,
            sessionId: $sessionId,
            status: "completed"
        }'
    printf '%s\n' "$chat_output"
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
