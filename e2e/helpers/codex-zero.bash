#!/usr/bin/env bash

# Helpers for the BYOK codex zero-web e2e smoke test.
#
# Provides authenticated curl wrappers and polling helpers used by
# `e2e/tests/03-runner/t-codex-zero-byok-smoke.bats`. We use curl + jq
# directly (no new CLI surface area) to keep scope minimal — same pattern
# as helpers/slack.bash.

# Resolve the token the CLI would use for authenticated calls.
# Priority matches turbo/apps/cli/src/lib/api/config.ts:
#   ZERO_TOKEN > VM0_TOKEN > ~/.vm0/config.json#token
_codex_zero_token() {
    if [[ -n "${ZERO_TOKEN:-}" ]]; then
        printf '%s' "$ZERO_TOKEN"
    elif [[ -n "${VM0_TOKEN:-}" ]]; then
        printf '%s' "$VM0_TOKEN"
    else
        jq -r '.token // empty' "$HOME/.vm0/config.json"
    fi
}

# Resolve the API base URL (matches CLI getApiUrl()).
_codex_zero_api_url() {
    if [[ -n "${VM0_API_URL:-}" ]]; then
        case "$VM0_API_URL" in
            http*) printf '%s' "$VM0_API_URL" ;;
            *)     printf 'https://%s' "$VM0_API_URL" ;;
        esac
    else
        jq -r '.apiUrl // "https://www.vm0.ai"' "$HOME/.vm0/config.json"
    fi
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

# Poll /api/zero/chat-threads/:id/messages until the newest assistant row
# reaches a terminal status. On success, exports:
#   LAST_RUN_ID      — runId of the assistant message
#   LAST_MSG_CONTENT — content text
# Usage: wait_for_chat_assistant_done <thread_id> [timeout_seconds]
wait_for_chat_assistant_done() {
    local thread_id="$1"
    local timeout="${2:-180}"
    local start=$SECONDS
    local body status_value run_id content
    while (( SECONDS - start < timeout )); do
        body=$(_codex_zero_curl "/api/zero/chat-threads/$thread_id/messages?limit=50" 2>/dev/null || true)
        if [[ -n "$body" ]]; then
            status_value=$(printf '%s' "$body" \
                | jq -r '[.messages[] | select(.role == "assistant")] | last | .status // ""' 2>/dev/null)
            # Per-poll diagnostic: bats's BATS_TEST_TIMEOUT kills the test before
            # the trailing "timed out" lines below run, so emit progress here.
            echo "# poll t=$((SECONDS - start))s status=${status_value:-EMPTY}" >&2
            case "$status_value" in
                completed|failed|timeout|cancelled)
                    run_id=$(printf '%s' "$body" \
                        | jq -r '[.messages[] | select(.role == "assistant")] | last | .runId // ""')
                    content=$(printf '%s' "$body" \
                        | jq -r '[.messages[] | select(.role == "assistant")] | last | .content // ""')
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
# and latestSessionProviderType stays null
# (turbo/apps/web/app/api/zero/integrations/chat/message/route.ts:17-77).
#
# Exports on success:
#   LAST_RUN_ID    — runId returned by the route
#   LAST_THREAD_ID — threadId returned by the route (newly created)
# Usage: send_chat_run_message <agent_id> <prompt>
send_chat_run_message() {
    local agent_id="$1"
    local prompt="$2"
    local payload body
    # debugNoMockCodex=true bypasses USE_MOCK_CODEX in the runner so the real
    # codex CLI executes against $OPENAI_API_KEY. Without it, CI's
    # USE_MOCK_CODEX=true env var causes guest-mock-codex to echo the prompt
    # verbatim — see crates/runner/src/executor.rs:1307-1313 and
    # crates/guest-mock-codex/src/main.rs:233-245. The chat/messages contract
    # exposes this flag via chatMessagesContract.body.debugNoMockCodex, mirroring
    # the same passthrough on /api/zero/runs.
    # Model-first selection can carry either the sentinel provider id for an org
    # policy route, or a concrete provider id for an explicit model/provider pin.
    # BYOK smoke tests use a concrete id so they do not mutate shared org policy.
    local selected_model="${CODEX_ZERO_SELECTED_MODEL:-gpt-5.5}"
    local model_provider_id="${CODEX_ZERO_MODEL_PROVIDER_ID:-00000000-0000-4000-8000-000000000000}"
    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg prompt "$prompt" \
        --arg modelProviderId "$model_provider_id" \
        --arg selectedModel "$selected_model" \
        '{agentId: $agentId, prompt: $prompt, modelSelection: {modelProviderId: $modelProviderId, selectedModel: $selectedModel}, hasTextContent: true, debugNoMockCodex: true}')
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

# Print the latestSessionProviderType of a chat thread.
#
# `latestSessionProviderType` is derived server-side as the
# `zero_runs.modelProvider` of the most recent run on the thread (see
# `getLatestRunProviderTypeForThread` in
# turbo/apps/web/src/lib/zero/chat-thread/chat-message-service.ts and
# turbo/apps/web/app/api/zero/chat-threads/[id]/route.ts:62). For this
# BYOK smoke test the org's only provider is openai-api-key, so once the
# run completes the field MUST be "openai-api-key" — proving the BYOK
# provider routing chain (provider -> codex framework dispatch) resolved
# end-to-end.
#
# We assert on this rather than the run's `framework` because (a)
# /api/zero/runs/:id does not project framework (`getRunResponseSchema`),
# and (b) /api/zero/runs/:id/telemetry/agent derives framework from
# `compose.agents.<name>.framework` via `extractFrameworkFromCompose` —
# intentionally absent from the test compose, so it would fall back to
# "claude-code" and produce a structural false-negative.
get_thread_provider_type() {
    local thread_id="$1"
    _codex_zero_curl "/api/zero/chat-threads/$thread_id" 2>/dev/null \
        | jq -r '.latestSessionProviderType // ""'
}
