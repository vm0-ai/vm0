#!/usr/bin/env bash

runner_e2e_require_environment() {
    require_runner_api_credentials || return
    command -v curl >/dev/null || return
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
        delete_runner_agent "$AGENT_ID" >/dev/null 2>&1 || true
    fi
    runner_e2e_delete_connector "$connector_slug" >/dev/null 2>&1 || true
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
    runner_api_curl "/api/zero/connectors/${connector_slug}/manual-grant" \
        -X POST \
        -d "$payload"
}

runner_e2e_delete_connector() {
    local connector_slug="$1"
    runner_api_curl "/api/zero/connectors/${connector_slug}" -X DELETE
}

runner_e2e_cancel_run() {
    local run_id="$1"
    runner_api_curl "/api/zero/runs/${run_id}/cancel" -X POST
}

runner_e2e_start_chat_run() {
    local agent_id="$1"
    local prompt="$2"
    local shell_prompt
    shell_prompt=$(printf '@shell@\n%s' "$prompt")
    runner_chat_send "$agent_id" "$shell_prompt" "" "deepseek-v4-flash"
}

runner_e2e_start_checkpointed_chat_run() {
    local agent_id="$1"
    local checkpoint_script="$2"
    local continuation_script="$3"
    local shell_prompt
    shell_prompt=$(printf '@shell-checkpoint@\n%s\n@continue@\n%s' \
        "$checkpoint_script" \
        "$continuation_script")
    runner_chat_send "$agent_id" "$shell_prompt" "" "deepseek-v4-flash"
}

runner_e2e_delete_chat_thread() {
    local thread_id="$1"
    runner_api_curl "/api/zero/chat-threads/${thread_id}" -X DELETE
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
        page=$(runner_api_curl "${path}${query}") || return
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

runner_e2e_wait_for_chat_text() {
    local thread_id="$1"
    local run_id="$2"
    local expected="$3"
    local timeout_seconds="${4:-90}"
    local started_at=$SECONDS
    local last_events='{}'
    local last_run='{}'
    local matched_text=""
    local run_status=""

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_events=$(runner_api_curl \
            "/api/zero/chat-threads/${thread_id}/events?limit=50" 2>&1) &&
            matched_text=$(jq -er --arg runId "$run_id" --arg expected "$expected" '
                [
                    .events[]?
                    | select(.eventType == "output.message" and .runId == $runId)
                    | .content
                    | select(type == "string" and contains($expected))
                ]
                | last // empty
            ' <<<"$last_events"); then
            printf '%s\n' "$matched_text"
            return 0
        fi

        if last_run=$(runner_api_curl "/api/zero/runs/${run_id}" 2>&1); then
            run_status=$(jq -r '.status // empty' <<<"$last_run")
            case "$run_status" in
                completed|failed|timeout|cancelled)
                    echo "Run ${run_id} reached terminal status ${run_status@Q} before ${expected@Q} was visible" >&2
                    echo "Last chat events: ${last_events}" >&2
                    echo "Last run response: ${last_run}" >&2
                    return 1
                    ;;
            esac
        fi
        sleep 2
    done

    echo "Timed out waiting for ${expected@Q} in chat events for run ${run_id}" >&2
    echo "Last chat events: ${last_events}" >&2
    echo "Last run response: ${last_run}" >&2
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

runner_e2e_wait_for_firewall_transition() {
    local run_id="$1"
    local firewall_name="$2"
    local host="$3"
    local method="$4"
    local url="$5"
    local permission="$6"
    local timeout_seconds="${7:-90}"
    local started_at=$SECONDS
    local last_logs='[]'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_logs=$(runner_e2e_network_logs "$run_id" 2>&1) &&
            jq -e \
                --arg firewallName "$firewall_name" \
                --arg host "$host" \
                --arg method "$method" \
                --arg url "$url" \
                --arg permission "$permission" '
                    [
                        to_entries[]
                        | select(
                            .value.firewall_name == $firewallName and
                            .value.host == $host and
                            .value.method == $method and
                            .value.url == $url and
                            .value.firewall_permission == $permission
                        )
                    ] as $matching
                    | any($matching[];
                        . as $denied
                        | $denied.value.action == "DENY" and
                            $denied.value.status == 403 and
                            any($matching[];
                                .key > $denied.key and .value.action == "ALLOW"
                            )
                    )
                ' <<<"$last_logs" >/dev/null; then
            printf '%s\n' "$last_logs"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for firewall transition ${firewall_name@Q} on ${url@Q} for run ${run_id}" >&2
    echo "Last network telemetry: ${last_logs}" >&2
    return 1
}
