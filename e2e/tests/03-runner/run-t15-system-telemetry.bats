#!/usr/bin/env bats

# Runner system telemetry coverage through the public agent, chat, and run APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

wait_for_runner_system_log() {
    local run_id="$1"
    local expected="$2"
    local timeout_seconds="${3:-90}"
    local started_at=$SECONDS
    local last_response='{}'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_response=$(runner_api_curl \
            "/api/zero/runs/${run_id}/telemetry/system-log?limit=100&order=asc" 2>&1) &&
            jq -e --arg expected "$expected" '
                (.systemLog | type) == "string" and
                (.systemLog | contains($expected)) and
                (.hasMore | type) == "boolean"
            ' <<<"$last_response" >/dev/null; then
            printf '%s\n' "$last_response"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for ${expected@Q} in system telemetry for run ${run_id}" >&2
    echo "Last system telemetry: ${last_response}" >&2
    return 1
}

wait_for_runner_metrics() {
    local run_id="$1"
    local timeout_seconds="${2:-90}"
    local started_at=$SECONDS
    local last_response='{}'

    while ((SECONDS - started_at < timeout_seconds)); do
        if last_response=$(runner_api_curl \
            "/api/zero/runs/${run_id}/telemetry/metrics?limit=100&order=asc" 2>&1) &&
            jq -e '
                (.metrics | type) == "array" and
                (.metrics | length) > 0 and
                (.hasMore | type) == "boolean"
            ' <<<"$last_response" >/dev/null; then
            printf '%s\n' "$last_response"
            return 0
        fi
        sleep 2
    done

    echo "Timed out waiting for resource metrics for run ${run_id}" >&2
    echo "Last metrics telemetry: ${last_response}" >&2
    return 1
}

@test "completed runner run exposes agent events, system logs, metrics, and pagination" {
    run create_runner_agent "runner-system-telemetry-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local output_marker="SYSTEM_TELEMETRY_OK_${TEST_ID}"
    run runner_e2e_start_chat_run \
        "$AGENT_ID" \
        "printf '%s\\n' '${output_marker}'"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    run jq -e '.status == "completed"' <<<"$output"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_agent_text "$RUN_ID" "$output_marker"
    echo "$output"
    assert_success

    run runner_e2e_agent_events "$RUN_ID"
    echo "$output"
    assert_success
    local agent_events="$output"
    run jq -e --arg marker "$output_marker" '
        any(.[];
            .eventType == "thread.started" and
            .eventData.type == "thread.started") and
        any(.[];
            .eventType == "item.completed" and
            .eventData.item.type == "agent_message" and
            (.eventData.item.text | contains($marker))) and
        any(.[];
            .eventType == "turn.completed" and
            .eventData.type == "turn.completed")
    ' <<<"$agent_events"
    echo "$output"
    assert_success

    run runner_api_curl \
        "/api/zero/runs/${RUN_ID}/telemetry/agent?limit=1&order=asc"
    echo "$output"
    assert_success
    local first_page="$output"
    run jq -e '
        (.events | length) == 1 and
        .hasMore == true and
        (.nextCursor | type) == "string" and
        (.nextCursor | length) > 0
    ' <<<"$first_page"
    echo "$output"
    assert_success

    local first_sequence next_cursor encoded_cursor
    first_sequence=$(jq -er '.events[0].sequenceNumber' <<<"$first_page")
    next_cursor=$(jq -er '.nextCursor' <<<"$first_page")
    encoded_cursor=$(jq -rn --arg cursor "$next_cursor" '$cursor | @uri')
    run runner_api_curl \
        "/api/zero/runs/${RUN_ID}/telemetry/agent?limit=1&order=asc&cursor=${encoded_cursor}"
    echo "$output"
    assert_success
    run jq -e --argjson firstSequence "$first_sequence" '
        (.events | length) == 1 and
        .events[0].sequenceNumber > $firstSequence and
        (.hasMore | type) == "boolean"
    ' <<<"$output"
    echo "$output"
    assert_success

    run wait_for_runner_system_log "$RUN_ID" "Complete webhook acknowledged"
    echo "$output"
    assert_success
    local system_log="$output"
    run jq -e '
        (.systemLog | contains("[INFO]")) and
        (.systemLog | contains("[sandbox:guest-agent]")) and
        (.systemLog | contains("Complete webhook acknowledged"))
    ' <<<"$system_log"
    echo "$output"
    assert_success

    run wait_for_runner_metrics "$RUN_ID"
    echo "$output"
    assert_success
    local metrics="$output"
    run jq -e '
        any(.metrics[];
            (.cpu | type) == "number" and
            .cpu >= 0 and
            .cpu <= 100 and
            (.mem_used | type) == "number" and
            (.mem_total | type) == "number" and
            .mem_used >= 0 and
            .mem_total > 0 and
            .mem_used <= .mem_total and
            (.disk_used | type) == "number" and
            (.disk_total | type) == "number" and
            .disk_used >= 0 and
            .disk_total > 0 and
            .disk_used <= .disk_total)
    ' <<<"$metrics"
    echo "$output"
    assert_success
}
