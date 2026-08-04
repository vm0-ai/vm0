#!/usr/bin/env bash

# Helpers for the BYOK codex zero-web e2e smoke test.
#
# Provides authenticated curl wrappers and polling helpers used by
# `e2e/tests/03-runner/t-codex-zero-byok-smoke.bats`. We use curl + jq
# directly (no new CLI surface area) to keep scope minimal — same pattern
# as helpers/slack.bash.

# Resolve the explicit E2E-only API credential.
_codex_zero_token() {
    e2e_api_token
}

# Resolve the explicit E2E API base URL.
_codex_zero_api_url() {
    e2e_api_url
}

# Issue an authenticated curl with vercel-bypass header.
# Caller passes any extra args (-X, -d, etc.). Path is appended to the
# resolved API URL.
# Usage: _codex_zero_curl <path> [extra curl args...]
_codex_zero_curl() {
    local path="$1"; shift
    local token base
    token=$(_codex_zero_token)
    base=$(_codex_zero_api_url)
    local -a hdrs=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        hdrs+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl -fsS "${hdrs[@]}" "$@" "$base$path"
}

_codex_zero_test_curl() {
    local path="$1"; shift
    local token base
    token=$(_codex_zero_token)
    base=$(_codex_zero_api_url)
    local -a hdrs=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        hdrs+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
        hdrs+=(-H "x-vm0-test-endpoint-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl -fsS "${hdrs[@]}" "$@" "$base$path"
}

# Enable the codex-beta feature switch for the current test user.
# Key must match FeatureSwitchKey.CodexBeta = "codexBeta" (camelCase) in
# turbo/packages/connectors/src/feature-switch-key.ts. isFeatureEnabled()
# resolves overrides via ctx.overrides[key] keyed by the enum value, so a
# wrong-cased key would be silently ignored.
enable_codex_beta() {
    _codex_zero_curl "/api/zero/feature-switches" \
        -X POST \
        -d '{"switches":{"codexBeta":true}}' \
        >/dev/null
}

configure_codex_zero_model_policy() {
    local model="$1"
    local provider_type="$2"
    local provider_id="$3"
    local current payload

    current=$(_codex_zero_curl "/api/zero/model-policies")
    payload=$(printf '%s' "$current" | jq -c \
        --arg model "$model" \
        --arg providerType "$provider_type" \
        --arg providerId "$provider_id" \
        '
        (.policies // [])
        | map({
            model,
            isDefault,
            defaultProviderType,
            credentialScope,
            modelProviderId
          }) as $existing
        | ($existing | map(select(.model != $model))) as $others
        | (
            ($existing | map(select(.model == $model)) | first)
            // {model: $model, isDefault: false}
          ) as $target
        | {
            policies: (
              $others
              + [
                  $target
                  + {
                      defaultProviderType: $providerType,
                      credentialScope: "org",
                      modelProviderId: $providerId
                    }
                ]
            )
          }
        ')

    _codex_zero_curl "/api/zero/model-policies" -X PUT -d "$payload" >/dev/null
}

# Poll /api/zero/chat-threads/:id/events until the current run has a terminal
# lifecycle event. Other output events, such as recommended followups, may be
# inserted after the terminal event and must not hide it. LAST_MSG_CONTENT
# comes from the latest non-blank output.message event for the same run.
# On a terminal event, exports:
#   LAST_RUN_ID              — runId of the terminal event
#   LAST_MSG_CONTENT         — content text
#   LAST_RUN_TERMINAL_STATUS — terminal event type
#   LAST_RUN_ERROR           — terminal event error, if present
# Usage: wait_for_chat_assistant_done <thread_id> [timeout_seconds]
wait_for_chat_assistant_done() {
    local thread_id="$1"
    local timeout="${2:-180}"
    local start=$SECONDS
    local body status_value run_id content terminal error_value
    if [[ -z "${LAST_RUN_ID:-}" ]]; then
        echo "# wait_for_chat_assistant_done: LAST_RUN_ID is required" >&2
        return 1
    fi
    local expected_run_id="$LAST_RUN_ID"
    LAST_MSG_CONTENT=""
    LAST_RUN_TERMINAL_STATUS=""
    LAST_RUN_ERROR=""
    export LAST_MSG_CONTENT LAST_RUN_TERMINAL_STATUS LAST_RUN_ERROR
    while (( SECONDS - start < timeout )); do
        body=$(_codex_zero_curl "/api/zero/chat-threads/$thread_id/events?limit=50" 2>/dev/null || true)
        if [[ -n "$body" ]]; then
            if ! terminal=$(printf '%s' "$body" \
                | jq -r --arg expectedRunId "$expected_run_id" '
                    [
                        .events[]
                        | select((.runId // "") == $expectedRunId)
                        | select(
                            (.eventType // "") as $eventType
                            | ["run.completed", "run.failed", "run.cancelled"]
                            | index($eventType)
                        )
                    ]
                    | last // {}
                ' 2>/dev/null); then
                echo "# wait_for_chat_assistant_done: invalid event response: $body" >&2
                return 1
            fi
            status_value=$(printf '%s' "$terminal" | jq -r '.eventType // ""')
            # Per-poll diagnostic: bats's BATS_TEST_TIMEOUT kills the test before
            # the trailing "timed out" lines below run, so emit progress here.
            echo "# poll t=$((SECONDS - start))s status=${status_value:-EMPTY}" >&2
            case "$status_value" in
                run.completed|run.failed|run.cancelled)
                    run_id=$(printf '%s' "$terminal" | jq -r '.runId // ""')
                    error_value=$(printf '%s' "$terminal" | jq -r '.error // ""')
                    if ! content=$(printf '%s' "$body" \
                        | jq -r --arg runId "$run_id" '
                            [
                                .events[]
                                | select(.eventType == "output.message")
                                | select((.runId // "") == $runId)
                                | select((.content // "") | test("\\S"))
                            ]
                            | last
                            | .content // ""
                        '); then
                        echo "# wait_for_chat_assistant_done: invalid output event response: $body" >&2
                        return 1
                    fi
                    export LAST_RUN_ID="$run_id"
                    export LAST_MSG_CONTENT="$content"
                    export LAST_RUN_TERMINAL_STATUS="$status_value"
                    export LAST_RUN_ERROR="$error_value"
                    echo "# wait_for_chat_assistant_done: terminal=$status_value run=$run_id error=${error_value:-none} ($((SECONDS - start))s)" >&2
                    return 0
                    ;;
            esac
        fi
        sleep "${CODEX_ZERO_POLL_INTERVAL_S:-3}"
    done
    echo "# wait_for_chat_assistant_done: timed out after $((SECONDS - start))s for thread $thread_id" >&2
    echo "# last body: $body" >&2
    # Fallback diagnostic: when the assistant message never reaches a terminal
    # status, the failure is in the run, not the chat-thread query. Dump the
    # run record so we can see whether it completed/failed, what its provider
    # resolved to, and whether the runner ever produced output.
    if [[ -n "${LAST_RUN_ID:-}" ]]; then
        echo "# fallback: GET /api/zero/runs/$LAST_RUN_ID" >&2
        _codex_zero_curl "/api/zero/runs/$LAST_RUN_ID" 2>&1 | head -100 >&2
    fi
    return 1
}

# Send a message that triggers a real run + eager-pin via the same path the
# web chat composer uses. POST /api/zero/chat/events is the unified
# "create thread (if needed) + run + association" endpoint
# (`chatEventsContract` in the chat-thread API contracts).
#
# We can't use `zero chat message send` here: that CLI hits
# /api/zero/integrations/chat/message, whose handler only inserts an
# assistant message with runId=null and creates the thread WITHOUT the
# pin parameter — no run is dispatched, so the codex CLI never executes
# (turbo/apps/web/app/api/zero/integrations/chat/message/route.ts:17-77).
#
# Exports on success:
#   LAST_RUN_ID    — runId returned by the route
#   LAST_THREAD_ID — threadId returned by the route (newly created)
# Usage: send_chat_run_message <agent_id> <prompt> <model>
send_chat_run_message() {
    local agent_id="$1"
    local prompt="$2"
    local selected_model="$3"
    local payload body client_event_id
    client_event_id=$(cat /proc/sys/kernel/random/uuid)
    # The caller uses a dedicated identity whose claim-time
    # RealAgentInPreview switch is enabled, so the real codex CLI executes
    # against $OPENAI_API_KEY. Keep the request field to mirror the current web
    # API contract; it is no longer the source of the claimed run setting.
    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg prompt "$prompt" \
        --arg selectedModel "$selected_model" \
        --arg clientEventId "$client_event_id" \
        '{agentId: $agentId, prompt: $prompt, userMessage: {version: 1, parts: [{type: "text", text: $prompt}]}, model: $selectedModel, clientEventId: $clientEventId, hasTextContent: true, realAgentInPreview: true}')
    body=$(_codex_zero_curl "/api/zero/chat/events" \
        -X POST \
        -d "$payload")
    LAST_RUN_ID=$(printf '%s' "$body" | jq -r '.runId // ""')
    LAST_THREAD_ID=$(printf '%s' "$body" | jq -r '.threadId // ""')
    export LAST_RUN_ID LAST_THREAD_ID
    [[ -n "$LAST_RUN_ID" && -n "$LAST_THREAD_ID" ]] || {
        echo "# send_chat_run_message: bad response: $body" >&2
        return 1
    }
}

# Run a real Codex chat request, retrying only the known transient model
# capacity response. Every retry uses a fresh thread, and passing still
# requires a real run.completed event for the caller's sentinel assertion.
# Exports the same LAST_* values as send_chat_run_message and
# wait_for_chat_assistant_done for the final attempt.
# Usage: run_codex_chat_with_capacity_retry <agent_id> <prompt> <model>
run_codex_chat_with_capacity_retry() {
    local agent_id="$1"
    local prompt="$2"
    local selected_model="$3"
    local capacity_error="selected model is at capacity. please try a different model."
    local max_attempts=3
    local attempt retry_delay failed_thread_id

    for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
        echo "# run_codex_chat_with_capacity_retry: model=$selected_model attempt=$attempt/$max_attempts" >&2
        if ! send_chat_run_message "$agent_id" "$prompt" "$selected_model"; then
            return 1
        fi
        if ! wait_for_chat_assistant_done "$LAST_THREAD_ID"; then
            return 1
        fi

        if [[ "$LAST_RUN_TERMINAL_STATUS" == "run.completed" ]]; then
            return 0
        fi
        if [[ "$LAST_RUN_TERMINAL_STATUS" != "run.failed" \
            || "${LAST_RUN_ERROR,,}" != *"$capacity_error"* ]]; then
            echo "# run_codex_chat_with_capacity_retry: non-retryable terminal=$LAST_RUN_TERMINAL_STATUS error=${LAST_RUN_ERROR:-none}" >&2
            return 1
        fi
        if (( attempt == max_attempts )); then
            echo "# run_codex_chat_with_capacity_retry: capacity retries exhausted: $LAST_RUN_ERROR" >&2
            return 1
        fi

        failed_thread_id="$LAST_THREAD_ID"
        if ! _codex_zero_curl "/api/zero/chat-threads/$failed_thread_id" -X DELETE >/dev/null; then
            echo "# run_codex_chat_with_capacity_retry: failed to delete thread $failed_thread_id" >&2
            return 1
        fi
        LAST_THREAD_ID=""
        export LAST_THREAD_ID

        retry_delay=$((attempt * 5))
        echo "# run_codex_chat_with_capacity_retry: model capacity unavailable; retrying in ${retry_delay}s" >&2
        sleep "$retry_delay"
    done

    return 1
}
