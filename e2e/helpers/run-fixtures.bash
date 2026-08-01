#!/usr/bin/env bash

# Direct-run lifecycle helpers for runner E2E fixtures. The legacy agent APIs
# are intentionally centralized here so tests provide structured request data
# without depending on the retired vm0 run command or its argument parser.

_validate_run_fixture_json() {
    local label="$1" value="$2"
    if ! jq -e 'type == "object"' <<< "$value" >/dev/null 2>&1; then
        echo "# $label must be a JSON object" >&2
        return 1
    fi
}

_compose_fixture_id() {
    local name="$1" encoded_name response
    encoded_name="$(jq -rn --arg value "$name" '$value | @uri')"
    response="$(e2e_api_curl "/api/test/agent-composes?name=$encoded_name")" || return 1
    jq -er '.id | select(type == "string" and length > 0)' <<< "$response"
}

_run_fixture_request() {
    local selector_key="$1" selector_value="$2" prompt="$3"
    local overrides="${4:-}"
    [[ -n "$overrides" ]] || overrides='{}'
    _validate_run_fixture_json "run fixture overrides" "$overrides" || return 1

    jq -cn \
        --arg selectorKey "$selector_key" \
        --arg selectorValue "$selector_value" \
        --arg prompt "$prompt" \
        --argjson overrides "$overrides" \
        '{realAgentInPreview: true} + $overrides + {prompt: $prompt} + {($selectorKey): $selectorValue}'
}

# POST a complete structured run request and print the compact create response.
# Usage: create_run_fixture <request-json>
create_run_fixture() {
    if [[ "$#" -ne 1 ]]; then
        echo "# Usage: create_run_fixture <request-json>" >&2
        return 1
    fi

    local request_json="$1" response
    _validate_run_fixture_json "run fixture request" "$request_json" || return 1
    response="$(e2e_api_curl "/api/test/agent-runs" -X POST --data-binary "$request_json")" || return 1
    jq -e '
        (.runId | type == "string" and length > 0)
        and (.sessionId | type == "string" and length > 0)
        and (.status | IN("queued", "pending", "running", "completed", "failed", "timeout", "cancelled"))
    ' <<< "$response" >/dev/null || {
        echo "# Invalid create-run response: $response" >&2
        return 1
    }
    jq -c '.' <<< "$response"
}

# Poll the Zero run read route and print the compact terminal response.
# Usage: wait_for_run_fixture <run-id> [timeout-seconds]
wait_for_run_fixture() {
    local run_id="$1" timeout="${2:-100}"
    local interval="${RUN_FIXTURE_POLL_INTERVAL_S:-2}"
    local start=$SECONDS response="" run_status=""

    while (( SECONDS - start < timeout )); do
        if response="$(e2e_api_curl "/api/zero/runs/$run_id" 2>&1)"; then
            run_status="$(jq -r '.status // empty' <<< "$response")"
            case "$run_status" in
                completed)
                    jq -c '.' <<< "$response"
                    return 0
                    ;;
                failed|timeout|cancelled)
                    jq -c '.' <<< "$response"
                    return 1
                    ;;
            esac
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for run fixture $run_id" >&2
    echo "# Last run response: $response" >&2
    return 1
}

# Cancel a pending or running fixture and print the compact API response.
# Usage: cancel_run_fixture <run-id>
cancel_run_fixture() {
    local run_id="$1" response
    response="$(e2e_api_curl "/api/zero/runs/$run_id/cancel" -X POST)" || return 1
    jq -e --arg runId "$run_id" '
        .id == $runId and .status == "cancelled"
    ' <<< "$response" >/dev/null || {
        echo "# Invalid cancel-run response: $response" >&2
        return 1
    }
    jq -c '.' <<< "$response"
}

# Execute a complete structured request, wait for its terminal state, and emit:
#   1. one compact metadata JSON line
#   2. structured agent event payloads from the API
# The first line is intentionally machine-readable and replaces vm0's human
# Run/Session/Checkpoint summary without emulating it.
# Usage: run_fixture <request-json>
run_fixture() {
    local request_json="$1" created final wait_status=0 run_id
    created="$(create_run_fixture "$request_json")" || return 1
    run_id="$(jq -er '.runId' <<< "$created")" || return 1
    final="$(wait_for_run_fixture "$run_id")" || wait_status=$?
    if [[ -z "$final" ]]; then
        return "$wait_status"
    fi

    jq -cn \
        --argjson created "$created" \
        --argjson final "$final" \
        '{
            runId: $created.runId,
            sessionId: ($final.result.agentSessionId // $created.sessionId),
            checkpointId: ($final.result.checkpointId // null),
            conversationId: ($final.result.conversationId // null),
            status: $final.status,
            error: ($final.error // $created.error // null)
        }'
    if [[ "$wait_status" -eq 0 ]]; then
        fetch_run_log "$run_id" agent || return 1
    else
        fetch_run_log "$run_id" agent || true
    fi
    return "$wait_status"
}

# Resolve a seeded compose name to its ID, then execute a structured request.
# Optional fields are supplied as one JSON object; no CLI flags are parsed.
# Runner E2E uses the real agent runtime by default. Tests whose subject is a
# mock-agent protocol or injected failure must opt out explicitly with
# `{ "realAgentInPreview": false }`.
# Usage: run_compose_fixture <compose-name> <prompt> [overrides-json]
run_compose_fixture() {
    local compose_name="$1" prompt="$2" overrides="${3:-}" compose_id request
    [[ -n "$overrides" ]] || overrides='{}'
    compose_id="$(_compose_fixture_id "$compose_name")" || return 1
    request="$(_run_fixture_request "agentComposeId" "$compose_id" "$prompt" "$overrides")" || return 1
    run_fixture "$request"
}

# Create without waiting, for lifecycle tests that need to cancel a live run.
# Usage: create_compose_run_fixture <compose-name> <prompt> [overrides-json]
create_compose_run_fixture() {
    local compose_name="$1" prompt="$2" overrides="${3:-}" compose_id request
    [[ -n "$overrides" ]] || overrides='{}'
    compose_id="$(_compose_fixture_id "$compose_name")" || return 1
    request="$(_run_fixture_request "agentComposeId" "$compose_id" "$prompt" "$overrides")" || return 1
    create_run_fixture "$request"
}

# Usage: run_compose_version_fixture <compose-version-id> <prompt> [overrides-json]
run_compose_version_fixture() {
    local version_id="$1" prompt="$2" overrides="${3:-}" request
    [[ -n "$overrides" ]] || overrides='{}'
    request="$(_run_fixture_request "agentComposeVersionId" "$version_id" "$prompt" "$overrides")" || return 1
    run_fixture "$request"
}

# Usage: continue_run_fixture <session-id> <prompt> [overrides-json]
continue_run_fixture() {
    local session_id="$1" prompt="$2" overrides="${3:-}" request
    [[ -n "$overrides" ]] || overrides='{}'
    request="$(_run_fixture_request "sessionId" "$session_id" "$prompt" "$overrides")" || return 1
    run_fixture "$request"
}

# Extract one field from the first metadata line emitted by run_fixture.
# Usage: run_fixture_field <captured-output> <jq-filter>
run_fixture_field() {
    local captured_output="$1" filter="$2"
    sed -n '1p' <<< "$captured_output" | jq -er "$filter"
}
