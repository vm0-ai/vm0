#!/usr/bin/env bats

# Mock Claude runtime regressions through the deployed public chat flow.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    local credentials="/tmp/e2e-api-credentials-runner-mock-claude.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

wait_for_mock_claude_events() {
    local run_id="$1"
    local timeout="${2:-45}"
    local interval="${RUNNER_EVENT_POLL_INTERVAL_SECONDS:-2}"
    local start=$SECONDS
    local response=""

    while ((SECONDS - start < timeout)); do
        if response="$(runner_api_curl \
            "/api/zero/runs/$run_id/telemetry/agent?limit=100&order=asc" \
            2>&1)" &&
            jq -e '
                .framework == "claude-code" and
                any(.events[]?.eventData |
                    . as $eventData |
                    if type == "string" then
                        try fromjson catch $eventData
                    else
                        .
                    end;
                    type == "object" and
                    .type == "result" and
                    .subtype == "success"
                )
            ' <<<"$response" >/dev/null; then
            printf '%s\n' "$response"
            return 0
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for mock Claude events for run $run_id" >&2
    echo "# Last event response: $response" >&2
    return 1
}

wait_for_system_log_text() {
    local run_id="$1"
    local expected="$2"
    local timeout="${3:-45}"
    local start=$SECONDS
    local response=""

    while ((SECONDS - start < timeout)); do
        if response="$(runner_api_curl \
            "/api/zero/runs/$run_id/telemetry/system-log?limit=100&order=desc" \
            2>&1)" &&
            jq -e --arg expected "$expected" \
                '.systemLog | contains($expected)' \
                <<<"$response" >/dev/null; then
            printf '%s\n' "$response"
            return 0
        fi
        sleep 2
    done

    echo "# Timed out (${timeout}s) waiting for system log text for run $run_id" >&2
    echo "# Last system log response: $response" >&2
    return 1
}

@test "public chat filters mock Claude JSONL stream noise" {
    run create_runner_agent "e2e-mock-claude-echo-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local session_id assistant_text protocol_noise prompt
    session_id="$(_runner_uuid)"
    assistant_text="echo-jsonl fixture response"
    protocol_noise="partial echo that should stay out of chat"
    prompt=$(cat <<EOF
@ECHO@
{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"$session_id","tools":["Bash"],"model":"mock-claude"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_echo_01"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"$protocol_noise"}}}
{"type":"stream_event","event":{"type":"content_block_stop"}}
{"type":"stream_event","event":{"type":"message_stop"}}
{"type":"assistant","session_id":"$session_id","message":{"role":"assistant","content":[{"type":"text","text":"$assistant_text"}]}}
{"type":"result","subtype":"success","session_id":"$session_id","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}
EOF
)

    run runner_chat_send "$AGENT_ID" "$prompt" "" "claude-sonnet-4-6"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 120
    echo "$output"
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 45
    echo "$output"
    assert_success
    assert_output "$assistant_text"

    run runner_api_curl "/api/zero/chat-threads/${THREAD_ID}/events?limit=50"
    echo "$output"
    assert_success
    local chat_events="$output"
    run jq -e \
        --arg runId "$RUN_ID" \
        --arg assistantText "$assistant_text" \
        --arg protocolNoise "$protocol_noise" '
        [.events[]? |
            select(.eventType == "output.message" and .runId == $runId) |
            .content
        ] as $outputs |
        ($outputs == [$assistantText]) and
        all($outputs[]; contains($protocolNoise) | not) and
        any(.events[]?;
            .eventType == "run.completed" and .runId == $runId
        )
    ' <<<"$chat_events"
    echo "$output"
    assert_success

    run wait_for_mock_claude_events "$RUN_ID"
    echo "$output"
    assert_success
    local agent_events="$output"
    run jq -e \
        --arg sessionId "$session_id" \
        --arg assistantText "$assistant_text" \
        --arg protocolNoise "$protocol_noise" '
        [.events[]?.eventData |
            . as $eventData |
            if type == "string" then
                try fromjson catch $eventData
            else
                .
            end
        ] as $payloads |
        .framework == "claude-code" and
        ($payloads | map(.type)) == ["system", "assistant", "result"] and
        ($payloads[0].subtype == "init") and
        ($payloads[0].session_id == $sessionId) and
        ($payloads[1].session_id == $sessionId) and
        ($payloads[1].message.content == [{type: "text", text: $assistantText}]) and
        ($payloads[2].session_id == $sessionId) and
        ($payloads[2].subtype == "success") and
        ($payloads[2].is_error == false) and
        ($payloads[2].result == "Done.") and
        ($payloads | tostring | contains($protocolNoise) | not)
    ' <<<"$agent_events"
    echo "$output"
    assert_success
}

@test "public chat completes after draining an orphaned Claude stdout pipe" {
    run create_runner_agent "e2e-mock-claude-orphan-pipe-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    run runner_chat_send "$AGENT_ID" "@orphan-pipe" "" "claude-sonnet-4-6"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    local started_at=$SECONDS
    run runner_wait_for_run "$RUN_ID" 90
    local elapsed=$((SECONDS - started_at))
    echo "$output"
    assert_success
    ((elapsed < 90))
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$THREAD_ID" "$RUN_ID" 45
    echo "$output"
    assert_success
    assert_output "Done."

    run runner_api_curl "/api/zero/chat-threads/${THREAD_ID}/events?limit=50"
    echo "$output"
    assert_success
    local chat_events="$output"
    run jq -e --arg runId "$RUN_ID" '
        ([.events[]? |
            select(.eventType == "output.message" and .runId == $runId) |
            .content
        ] == ["Done."]) and
        any(.events[]?;
            .eventType == "run.completed" and .runId == $runId
        )
    ' <<<"$chat_events"
    echo "$output"
    assert_success

    run wait_for_mock_claude_events "$RUN_ID"
    echo "$output"
    assert_success
    local agent_events="$output"
    run jq -e '
        [.events[]?.eventData |
            . as $eventData |
            if type == "string" then
                try fromjson catch $eventData
            else
                .
            end
        ] as $payloads |
        .framework == "claude-code" and
        ($payloads | map(.type)) == ["system", "result"] and
        ($payloads[0].subtype == "init") and
        ($payloads[1].subtype == "success") and
        ($payloads[1].is_error == false) and
        ($payloads[1].result == "Done.")
    ' <<<"$agent_events"
    echo "$output"
    assert_success

    run wait_for_system_log_text \
        "$RUN_ID" \
        "Stdout drain deadline reached after 5s, possible orphaned child process"
    echo "$output"
    assert_success
}
