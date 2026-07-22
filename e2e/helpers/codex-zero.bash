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

# Do not clear feature-switch overrides in teardown. Runner E2E files execute
# in parallel and share the same authenticated runner user; DELETE
# /api/zero/feature-switches removes every override for that shared user, which
# can race another file between enable_codex_beta and its gated API call.
#
# Leaving codexBeta enabled is intentional for the shared E2E runner user.
# Tests that need feature-off behavior must use a dedicated token/user and
# explicitly force the switch off for that isolated identity.
disable_codex_beta() {
    return 0
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

# Poll /api/zero/chat-threads/:id/messages until the current run has a terminal
# assistant lifecycle marker (the paged message API no longer exposes agent run
# status; terminal runs append a null-content lifecycle marker row instead).
# Other assistant marker rows, such as recommended followups, may be inserted
# after the terminal marker and must not hide it. LAST_MSG_CONTENT comes from
# the latest non-blank assistant content row for the same run.
# On success, exports:
#   LAST_RUN_ID      — runId of the assistant message
#   LAST_MSG_CONTENT — content text
# Usage: wait_for_chat_assistant_done <thread_id> [timeout_seconds]
wait_for_chat_assistant_done() {
    local thread_id="$1"
    local timeout="${2:-180}"
    local start=$SECONDS
    local body status_value run_id content terminal
    if [[ -z "${LAST_RUN_ID:-}" ]]; then
        echo "# wait_for_chat_assistant_done: LAST_RUN_ID is required" >&2
        return 1
    fi
    local expected_run_id="$LAST_RUN_ID"
    while (( SECONDS - start < timeout )); do
        body=$(_codex_zero_curl "/api/zero/chat-threads/$thread_id/messages?limit=50" 2>/dev/null || true)
        if [[ -n "$body" ]]; then
            terminal=$(printf '%s' "$body" \
                | jq -r --arg expectedRunId "$expected_run_id" '
                    [
                        .messages[]
                        | select(.role == "assistant")
                        | select((.runId // "") == $expectedRunId)
                        | select(
                            (.runLifecycleEvent // "") as $event
                            | ["completed", "failed", "timeout", "cancelled"]
                            | index($event)
                        )
                    ]
                    | last // {}
                    | [(.runLifecycleEvent // ""), (.runId // "")]
                    | @tsv
                ' 2>/dev/null)
            status_value="${terminal%%$'\t'*}"
            # Per-poll diagnostic: bats's BATS_TEST_TIMEOUT kills the test before
            # the trailing "timed out" lines below run, so emit progress here.
            echo "# poll t=$((SECONDS - start))s status=${status_value:-EMPTY}" >&2
            case "$status_value" in
                completed|failed|timeout|cancelled)
                    run_id="${terminal#*$'\t'}"
                    content=$(printf '%s' "$body" \
                        | jq -r --arg runId "$run_id" '
                            [
                                .messages[]
                                | select(.role == "assistant")
                                | select((.runId // "") == $runId)
                                | select((.content // "") | test("\\S"))
                            ]
                            | last
                            | .content // ""
                        ')
                    export LAST_RUN_ID="$run_id"
                    export LAST_MSG_CONTENT="$content"
                    echo "# wait_for_chat_assistant_done: terminal=$status_value run=$run_id ($((SECONDS - start))s)" >&2
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
# web chat composer uses. POST /api/zero/chat/messages is the unified
# "create thread (if needed) + run + association" endpoint
# (chatMessagesContract in
# turbo/packages/api-contracts/src/contracts/chat-threads.ts:281-327).
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
    local payload body
    # realAgentInPreview=true bypasses USE_MOCK_CODEX in the runner so the real
    # codex CLI executes against $OPENAI_API_KEY. Without it, CI's
    # USE_MOCK_CODEX=true env var causes guest-mock-codex to echo the prompt
    # verbatim — see crates/runner/src/executor.rs (insert_codex_env) and
    # guest_mock_codex::build_events.
    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg prompt "$prompt" \
        --arg selectedModel "$selected_model" \
        '{agentId: $agentId, prompt: $prompt, model: $selectedModel, hasTextContent: true, realAgentInPreview: true}')
    body=$(_codex_zero_curl "/api/zero/chat/messages" \
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
