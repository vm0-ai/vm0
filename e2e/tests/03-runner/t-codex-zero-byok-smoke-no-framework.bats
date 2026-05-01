#!/usr/bin/env bats

# BYOK codex via zero web layer — production-shaped path (no compose framework
# declaration). Sibling of t-codex-zero-byok-smoke.bats with the
# `framework: codex` line dropped, so the compose defaults to claude-code while
# the agent's eager-pinned openai-api-key provider must drive dispatch.
#
# Covers the regression from issue #11645: pre-fix the runner would launch
# claude-code despite the openai-api-key eager-pin, because resolvedFramework
# was never wired into the dispatched ExecutionContext. With the fix the
# provider's framework wins and codex is launched.
#
# OPENAI_API_KEY is mandatory — CI injects it via secrets.OPENAI_API_KEY and
# local runs must export it. There is no skip path: if the key is missing, the
# test fails naturally, matching t-codex-zero-byok-smoke.bats's contract.

load '../../helpers/setup'
load '../../helpers/codex-zero'

# Same cold-path budget as the sibling smoke — provider resolve → eager-pin →
# guest-agent boot → codex exec.
export BATS_TEST_TIMEOUT=300

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-codex-byok-nofw-${UNIQUE_ID}"

    # 1. Feature switch on (also fails the file early if not yet wired)
    enable_codex_beta

    # 2. Org-level openai-api-key provider — picked up as default by eager-pin
    $ZERO_CLI org model-provider setup --type "openai-api-key" --secret "$OPENAI_API_KEY" >/dev/null

    # 3. Compose intentionally OMITS framework: codex. This is the
    # production-shape from #11645 — the web composer creates composes
    # with the default framework (claude-code). With the fix in place,
    # the openai-api-key eager-pin's framework drives dispatch.
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "BYOK codex zero web smoke (no framework declaration)"
    working_dir: /home/user/workspace
EOF

    local compose_json
    compose_json=$($VM0_CLI compose "$TEST_DIR/vm0-basic.yaml" --json)
    export AGENT_ID
    AGENT_ID=$(printf '%s' "$compose_json" | jq -r '.composeId')
    [[ -n "$AGENT_ID" && "$AGENT_ID" != "null" ]] \
        || { echo "# compose --json output: $compose_json" >&2; return 1; }

    # 4. Seed the zero_agents row via the metadata upsert path, identical
    # to the sibling smoke. See its setup_file comment for rationale.
    _codex_zero_curl "/api/zero/composes/$AGENT_ID/metadata" \
        -X PATCH -d '{"displayName":"BYOK codex e2e (no framework)"}' >/dev/null
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

@test "t-codex-zero-byok-smoke-no-framework: provider framework drives dispatch when compose omits framework: codex" {
    # Trigger a real run via the unified chat endpoint. The helper exports
    # LAST_RUN_ID + LAST_THREAD_ID; called without `run` so the exports
    # propagate (see sibling smoke for full rationale).
    send_chat_run_message "$AGENT_ID" \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    THREAD_ID="$LAST_THREAD_ID"
    [[ -n "$THREAD_ID" ]] || fail "Could not extract thread id from chat/messages response"
    export THREAD_ID

    # Wait for the assistant message to terminate.
    wait_for_chat_assistant_done "$THREAD_ID"

    # Assert: real codex produced the expected sentinel — proves the codex
    # binary (not claude-code) actually ran.
    [[ "$LAST_MSG_CONTENT" == *"RESULT=579"* ]] \
        || fail "Expected 'RESULT=579' in assistant content, got: $LAST_MSG_CONTENT"

    # Assert: the run used the openai-api-key BYOK provider end-to-end.
    provider_type=$(get_thread_provider_type "$THREAD_ID")
    [[ "$provider_type" == "openai-api-key" ]] \
        || fail "Expected latestSessionProviderType=openai-api-key, got: $provider_type (thread=$THREAD_ID)"
}
