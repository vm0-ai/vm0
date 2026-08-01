#!/usr/bin/env bats

# BYOK codex via zero web layer — full integration smoke.
#
# Validates the chain added by epic #11520:
#   feature-switch on  →  zero org model-provider setup --type openai-api-key
#   →  model policy routes the selected Codex model to that BYOK provider
#   →  compose fixture API  →
#   POST /api/zero/chat/events (the same unified create-thread + run endpoint
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
    use_e2e_api_credentials "runner-real-codex"
    set_real_agent_in_preview true

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-codex-byok-${UNIQUE_ID}"

    # 1. Feature switch on (also fails the file early if not yet wired)
    enable_codex_beta

    # 2. Org-level openai-api-key provider. Chat writes only carry the selected
    # model; provider resolution comes from org model policy.
    configure_e2e_model_provider "openai-api-key" "$OPENAI_API_KEY"
    export OPENAI_PROVIDER_ID
    OPENAI_PROVIDER_ID=$(zero_model_provider_id_by_type "openai-api-key")
    configure_codex_zero_model_policy \
        "gpt-5.5" \
        "openai-api-key" \
        "$OPENAI_PROVIDER_ID"
    configure_codex_zero_model_policy \
        "gpt-5.6-luna" \
        "openai-api-key" \
        "$OPENAI_PROVIDER_ID"

    # 3. Compose declares framework: codex explicitly. The framework is
    # resolved from the org model policy route. At secret resolution the
    # provider's declared framework wins (Epic #11520) and is propagated
    # downstream via build-zero-context.ts's resolvedFramework, with no
    # compose-vs-provider equality check.
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "BYOK codex zero web smoke test"
    framework: codex
EOF

    local compose_json
    compose_json=$(seed_compose_fixture "$TEST_DIR/vm0-basic.yaml")
    export AGENT_ID
    AGENT_ID=$(printf '%s' "$compose_json" | jq -r '.composeId')
    [[ -n "$AGENT_ID" && "$AGENT_ID" != "null" ]] \
        || { echo "# compose fixture response: $compose_json" >&2; return 1; }

    # 4. Seed the zero_agents row (PK = composeId) without changing the
    # compose version created above; the product PUT route rewrites server-side
    # agent compose content and would erase framework: codex from this fixture.
    _codex_zero_test_curl "/api/test/zero-agent-state/action" \
        -X POST -d "{\"action\":\"seed-agent\",\"agent_id\":\"$AGENT_ID\",\"display_name\":\"BYOK codex e2e\",\"visibility\":\"private\"}" >/dev/null
}

teardown() {
    # Best-effort cleanup; never mask the actual test failure.
    if [[ -n "${THREAD_ID:-}" ]]; then
        _codex_zero_curl "/api/zero/chat-threads/$THREAD_ID" -X DELETE >/dev/null 2>&1 || true
    fi
}

teardown_file() {
    if [[ -n "${AGENT_ID:-}" ]]; then
        delete_e2e_agent "$AGENT_ID" >/dev/null 2>&1 || true
    fi
    disable_codex_beta
    if [[ -n "$TEST_DIR" && -d "$TEST_DIR" ]]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t-codex-zero-byok-smoke-1: gpt-5.5 via zero web layer" {
    # Trigger a real run by hitting the same unified chat endpoint the web
    # composer uses. This both creates the thread (with eager-pin) and
    # dispatches the codex run in one call. Sets LAST_RUN_ID + LAST_THREAD_ID.
    #
    # Called directly (no `run`) because bats `run` executes in a subshell —
    # `export` from the helper would not propagate back to this scope, and
    # LAST_THREAD_ID / LAST_RUN_ID would arrive empty. The helper returns
    # non-zero on failure, which fails the test naturally.
    send_chat_run_message "$AGENT_ID" \
        "Compute 123+456 and reply with exactly: RESULT=<answer>" \
        "gpt-5.5"

    THREAD_ID="$LAST_THREAD_ID"
    [[ -n "$THREAD_ID" ]] || fail "Could not extract thread id from chat/messages response"
    export THREAD_ID

    # Wait for the assistant message to terminate. Resets LAST_RUN_ID to the
    # terminal assistant row's runId and LAST_MSG_CONTENT to that run's latest
    # non-blank assistant content. Also called without `run` so its exports
    # survive the subshell boundary.
    wait_for_chat_assistant_done "$THREAD_ID"

    # Assert: real codex produced the expected sentinel. The selected model's
    # policy routes to openai-api-key, so a real (non-mock) codex completion
    # proves the BYOK provider routing chain resolved end-to-end — without the
    # key the run cannot produce the sentinel.
    [[ "$LAST_MSG_CONTENT" == *"RESULT=579"* ]] \
        || fail "Expected 'RESULT=579' in assistant content, got: $LAST_MSG_CONTENT"
}

@test "t-codex-zero-byok-smoke-2: gpt-5.6-luna via zero web layer" {
    send_chat_run_message "$AGENT_ID" \
        "Compute 234+567 and reply with exactly: LUNA_RESULT=<answer>" \
        "gpt-5.6-luna"

    THREAD_ID="$LAST_THREAD_ID"
    [[ -n "$THREAD_ID" ]] || fail "Could not extract thread id from chat/messages response"
    export THREAD_ID

    wait_for_chat_assistant_done "$THREAD_ID"

    [[ "$LAST_MSG_CONTENT" == *"LUNA_RESULT=801"* ]] \
        || fail "Expected 'LUNA_RESULT=801' in assistant content, got: $LAST_MSG_CONTENT"
}
