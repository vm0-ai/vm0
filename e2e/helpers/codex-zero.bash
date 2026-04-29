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

# Clear all of the current test user's feature-switch overrides (best-effort
# cleanup). Using DELETE rather than POST-flip-to-false avoids leaking the
# override to subsequent serial-layer tests sharing E2E_SERIAL_EMAIL if the
# request 5xxs.
disable_codex_beta() {
    _codex_zero_curl "/api/zero/feature-switches" \
        -X DELETE \
        >/dev/null 2>&1 || true
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
    return 1
}

# Print the framework field of a run record. Used in assertions.
# Reads from /api/zero/runs/:id/telemetry/agent (which projects `framework`
# via agentEventsResponseSchema) rather than /api/zero/runs/:id (which does
# not — see getRunResponseSchema in
# turbo/packages/api-contracts/src/contracts/runs.ts).
get_run_framework() {
    local run_id="$1"
    _codex_zero_curl "/api/zero/runs/$run_id/telemetry/agent?limit=1" 2>/dev/null \
        | jq -r '.framework // ""'
}
