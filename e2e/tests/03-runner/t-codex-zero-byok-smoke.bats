#!/usr/bin/env bats

# BYOK codex via zero web layer — full integration smoke.
#
# Validates the chain added by epic #11520:
#   feature-switch on  →  zero org model-provider setup --type openai-api-key
#   →  model policy routes gpt-5.5 to that BYOK provider  →  vm0 compose  →
#   POST /api/zero/chat/messages (the same unified create-thread + run endpoint
#   the web composer uses) → thread pins the selected model  →  real codex CLI runs with
#   $OPENAI_API_KEY  →  response contains the expected sentinel.
#
# OPENAI_API_KEY is mandatory — CI injects it via secrets.OPENAI_API_KEY and
# local runs must export it. There is no skip path: if the key is missing, the
# test fails naturally, matching t-codex-real-smoke.bats's contract.

load '../../helpers/setup'
load '../../helpers/codex-zero'

# Codex run via zero web layer involves: provider resolve → eager-pin →
# guest-agent boot → codex exec. Cold path can exceed default 120s; bump
# per-test to 300s. t-codex-real-smoke uses the same model but a different
# dispatch path (direct CLI), so 120s is sufficient there.
export BATS_TEST_TIMEOUT=300

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-codex-byok-${UNIQUE_ID}"

    # 1. Feature switch on (also fails the file early if not yet wired)
    enable_codex_beta

    # 2. Org-level openai-api-key provider. The selected model is explicitly
    # pinned to this provider on the chat message, without provider defaults or
    # shared org policy mutation.
    $ZERO_CLI org model-provider setup --type "openai-api-key" --secret "$OPENAI_API_KEY" >/dev/null
    export OPENAI_PROVIDER_ID
    OPENAI_PROVIDER_ID=$(zero_model_provider_id_by_type "openai-api-key")
    export CODEX_ZERO_SELECTED_MODEL="gpt-5.5"
    export CODEX_ZERO_MODEL_PROVIDER_ID="$OPENAI_PROVIDER_ID"

    # 3. Compose declares framework: codex explicitly. The framework is
    # resolved from the explicit model-first provider pin. At secret resolution
    # the provider's declared framework wins (Epic #11520) and is propagated
    # downstream via build-zero-context.ts's resolvedFramework, with no
    # compose-vs-provider equality check.
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "BYOK codex zero web smoke test"
    framework: codex
    working_dir: /home/user/workspace
EOF

    local compose_json
    compose_json=$($VM0_CLI compose "$TEST_DIR/vm0-basic.yaml" --json)
    export AGENT_ID
    AGENT_ID=$(printf '%s' "$compose_json" | jq -r '.composeId')
    [[ -n "$AGENT_ID" && "$AGENT_ID" != "null" ]] \
        || { echo "# compose --json output: $compose_json" >&2; return 1; }

    # 4. Seed the zero_agents row (PK = composeId). vm0 compose's
    # POST /api/agent/composes only inserts agent_composes +
    # agent_compose_versions; the zero_agents row is created lazily by
    # the web composer's metadata upsert. POST /api/zero/chat/messages
    # requires that row (route.ts calls fetchZeroAgentForRun WHERE id =
    # body.agentId and 404s when undefined). PATCHing metadata is the
    # smallest write that triggers the upsert in
    # zero-compose-service.ts updateComposeMetadata.
    _codex_zero_curl "/api/zero/composes/$AGENT_ID/metadata" \
        -X PATCH -d '{"displayName":"BYOK codex e2e"}' >/dev/null
}

teardown_file() {
    # Best-effort cleanup; never mask the actual test failure.
    if [[ -n "${THREAD_ID:-}" ]]; then
        _codex_zero_curl "/api/zero/chat-threads/$THREAD_ID" -X DELETE >/dev/null 2>&1 || true
    fi
    $ZERO_CLI org model-provider remove "openai-api-key" 2>/dev/null || true
    disable_codex_beta
    if [[ -n "$TEST_DIR" && -d "$TEST_DIR" ]]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t-codex-zero-byok-smoke: full BYOK codex via zero web layer" {
    # Trigger a real run by hitting the same unified chat endpoint the web
    # composer uses. This both creates the thread (with eager-pin) and
    # dispatches the codex run in one call. Sets LAST_RUN_ID + LAST_THREAD_ID.
    #
    # Called directly (no `run`) because bats `run` executes in a subshell —
    # `export` from the helper would not propagate back to this scope, and
    # LAST_THREAD_ID / LAST_RUN_ID would arrive empty. The helper returns
    # non-zero on failure, which fails the test naturally.
    send_chat_run_message "$AGENT_ID" \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    THREAD_ID="$LAST_THREAD_ID"
    [[ -n "$THREAD_ID" ]] || fail "Could not extract thread id from chat/messages response"
    export THREAD_ID

    # Wait for the assistant message to terminate. Resets LAST_RUN_ID +
    # LAST_MSG_CONTENT to the assistant row's runId/content. Also called
    # without `run` so its exports survive the subshell boundary.
    wait_for_chat_assistant_done "$THREAD_ID"

    # Assert: real codex produced the expected sentinel.
    [[ "$LAST_MSG_CONTENT" == *"RESULT=579"* ]] \
        || fail "Expected 'RESULT=579' in assistant content, got: $LAST_MSG_CONTENT"

    # Assert: the run that just completed used the openai-api-key BYOK
    # provider (latestSessionProviderType reads zero_runs.modelProvider of
    # the most recent run on the thread). Proves the BYOK provider routing
    # chain (provider -> codex framework dispatch) resolved end-to-end.
    provider_type=$(get_thread_provider_type "$THREAD_ID")
    [[ "$provider_type" == "openai-api-key" ]] \
        || fail "Expected latestSessionProviderType=openai-api-key, got: $provider_type (thread=$THREAD_ID)"
}
