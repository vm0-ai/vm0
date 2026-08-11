#!/usr/bin/env bash

runner_e2e_require_environment() {
    : "${E2E_API_TOKEN:?runner E2E API token is required}"
    : "${E2E_API_URL:?runner E2E API URL is required}"
    command -v curl >/dev/null
    command -v jq >/dev/null
}

runner_e2e_setup_test() {
    TEST_ID="${E2E_RUNNER_SHARD_INDEX:-local}-$(date +%s)-$RANDOM"
    AGENT_ID=""
    THREAD_ID=""
    RUN_ID=""
}

runner_e2e_teardown_test() {
    local connector_slug="$1"
    if [[ -n "${RUN_ID:-}" ]]; then
        runner_e2e_cancel_run "$RUN_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${THREAD_ID:-}" ]]; then
        runner_e2e_delete_chat_thread "$THREAD_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${AGENT_ID:-}" ]]; then
        runner_e2e_delete_agent "$AGENT_ID" >/dev/null 2>&1 || true
    fi
    runner_e2e_delete_connector "$connector_slug" >/dev/null 2>&1 || true
}

runner_e2e_api_request() {
    local method="$1"
    local path="$2"
    local body="${3-}"
    local -a args=(
        --fail-with-body
        --silent
        --show-error
        --max-time 60
        --request "$method"
        --header "Authorization: Bearer ${E2E_API_TOKEN}"
        --header "Accept: application/json"
    )

    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        args+=(--header "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
    fi
    if [[ $# -ge 3 ]]; then
        args+=(--header "Content-Type: application/json" --data-binary "$body")
    fi

    curl "${args[@]}" "${E2E_API_URL%/}${path}"
}

runner_e2e_create_private_agent() {
    local display_name="$1"
    local payload
    payload=$(jq -nc --arg displayName "$display_name" '{displayName: $displayName, visibility: "private"}')
    runner_e2e_api_request POST "/api/zero/agents" "$payload"
}

runner_e2e_delete_agent() {
    local agent_id="$1"
    runner_e2e_api_request DELETE "/api/zero/agents/${agent_id}"
}

runner_e2e_connect_manual_connector() {
    local connector_slug="$1"
    local auth_method="$2"
    local agent_id="$3"
    local values="$4"
    local payload
    payload=$(jq -nc \
        --arg authMethod "$auth_method" \
        --arg agentId "$agent_id" \
        --argjson values "$values" \
        '{authMethod: $authMethod, agentId: $agentId, authorizeAgent: true, values: $values}')
    runner_e2e_api_request \
        POST \
        "/api/zero/connectors/${connector_slug}/manual-grant" \
        "$payload"
}

runner_e2e_delete_connector() {
    local connector_slug="$1"
    runner_e2e_api_request DELETE "/api/zero/connectors/${connector_slug}"
}

runner_e2e_cancel_run() {
    local run_id="$1"
    runner_e2e_api_request POST "/api/zero/runs/${run_id}/cancel"
}

runner_e2e_start_chat_run() {
    local agent_id="$1"
    local prompt="$2"
    local shell_prompt
    local client_thread_id
    local payload
    shell_prompt=$(printf '@shell@\n%s' "$prompt")
    client_thread_id=$(cat /proc/sys/kernel/random/uuid)
    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg clientThreadId "$client_thread_id" \
        --arg model "deepseek-v4-flash" \
        --arg prompt "$shell_prompt" \
        '{
            agentId: $agentId,
            clientThreadId: $clientThreadId,
            model: $model,
            prompt: $prompt,
            userMessage: {version: 1, parts: [{type: "text", text: $prompt}]},
            hasTextContent: true
        }')
    runner_e2e_api_request POST "/api/zero/chat/events" "$payload"
}

runner_e2e_delete_chat_thread() {
    local thread_id="$1"
    runner_e2e_api_request DELETE "/api/zero/chat-threads/${thread_id}"
}

runner_e2e_wait_for_run_completed() {
    local run_id="$1"
    local timeout_seconds="${2:-180}"
    local started_at=$SECONDS
    local last_response=""
    local status=""

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_response=$(runner_e2e_api_request GET "/api/zero/runs/${run_id}" 2>&1); then
            status=$(jq -er '.status' <<<"$last_response") || {
                echo "Runner E2E run returned an invalid status payload: $last_response" >&2
                return 1
            }
            case "$status" in
                completed)
                    printf '%s\n' "$last_response"
                    return 0
                    ;;
                failed | timeout | cancelled)
                    echo "Runner E2E run ${run_id} reached ${status}: $last_response" >&2
                    return 1
                    ;;
            esac
        fi
        sleep 2
    done

    echo "Timed out after ${timeout_seconds}s waiting for runner E2E run ${run_id}" >&2
    echo "Last run response: ${last_response}" >&2
    return 1
}

runner_e2e_agent_events() {
    local run_id="$1"
    runner_e2e_collect_pages "/api/zero/runs/${run_id}/telemetry/agent" events
}

runner_e2e_network_logs() {
    local run_id="$1"
    runner_e2e_collect_pages "/api/zero/runs/${run_id}/network" networkLogs
}

runner_e2e_collect_pages() {
    local path="$1"
    local collection_key="$2"
    local accumulated='[]'
    local cursor=""
    local encoded_cursor
    local has_more
    local next_cursor
    local page

    local page_number
    for ((page_number = 1; page_number <= 50; page_number += 1)); do
        local query="?limit=100&order=asc"
        if [[ -n "$cursor" ]]; then
            encoded_cursor=$(jq -rn --arg cursor "$cursor" '$cursor | @uri')
            query="${query}&cursor=${encoded_cursor}"
        fi
        page=$(runner_e2e_api_request GET "${path}${query}") || return
        accumulated=$(jq -c \
            --arg collectionKey "$collection_key" \
            --argjson accumulated "$accumulated" \
            '$accumulated + .[$collectionKey]' \
            <<<"$page") || return
        has_more=$(jq -r \
            'if (.hasMore | type) == "boolean" then .hasMore else error("invalid hasMore") end' \
            <<<"$page") || {
            echo "Runner E2E telemetry returned an invalid page: $page" >&2
            return 1
        }
        if [[ "$has_more" != "true" ]]; then
            printf '%s\n' "$accumulated"
            return 0
        fi
        next_cursor=$(jq -er '.nextCursor | select(type == "string" and length > 0)' <<<"$page") || {
            echo "Runner E2E telemetry page is missing nextCursor: $page" >&2
            return 1
        }
        cursor="$next_cursor"
    done

    echo "Runner E2E telemetry exceeded 50 pages for ${path}" >&2
    return 1
}

runner_e2e_wait_for_agent_text() {
    local run_id="$1"
    local expected="$2"
    local timeout_seconds="${3:-90}"
    local started_at=$SECONDS
    local last_events='[]'
    local matched_text=""

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_events=$(runner_e2e_agent_events "$run_id" 2>&1) &&
            matched_text=$(jq -er --arg expected "$expected" '
                [
                    .[]
                    | select(.eventType == "item.completed")
                    | .eventData.item
                    | select(.type == "agent_message")
                    | .text
                    | select(type == "string" and contains($expected))
                ]
                | last // empty
            ' <<<"$last_events"); then
            printf '%s\n' "$matched_text"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for ${expected@Q} in agent telemetry for run ${run_id}" >&2
    echo "Last agent telemetry: ${last_events}" >&2
    return 1
}

runner_e2e_wait_for_firewall_log() {
    local run_id="$1"
    local firewall_name="$2"
    local host="$3"
    local expected_secrets="$4"
    local expected_url_rewrite="${5:-ignore}"
    local timeout_seconds="${6:-90}"
    local started_at=$SECONDS
    local last_logs='[]'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_logs=$(runner_e2e_network_logs "$run_id" 2>&1) &&
            jq -e \
                --arg firewallName "$firewall_name" \
                --arg host "$host" \
                --arg expectedUrlRewrite "$expected_url_rewrite" \
                --argjson expectedSecrets "$expected_secrets" \
                'any(.[];
                    .firewall_name == $firewallName and
                    .host == $host and
                    .action == "ALLOW" and
                    (((.auth_resolved_secrets // []) | sort) == ($expectedSecrets | sort)) and
                    ($expectedUrlRewrite == "ignore" or
                        .auth_url_rewrite == ($expectedUrlRewrite == "true")))' \
                <<<"$last_logs" >/dev/null; then
            printf '%s\n' "$last_logs"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for firewall ${firewall_name@Q} on ${host@Q} for run ${run_id}" >&2
    echo "Last network telemetry: ${last_logs}" >&2
    return 1
}
