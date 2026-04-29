#!/usr/bin/env bats

# BYOK codex via zero web layer — full integration smoke.
#
# Validates the chain added by epic #11520:
#   feature-switch on  →  zero org model-provider setup --type openai-api-key
#   →  vm0 compose  →  zero chat message send  →  thread inherits provider via
#   #11528 eager-pin  →  real codex CLI runs with $OPENAI_API_KEY  →  response
#   contains the expected sentinel.
#
# OPENAI_API_KEY is mandatory — CI injects it via secrets.OPENAI_API_KEY and
# local runs must export it. There is no skip path: if the key is missing, the
# test fails naturally, matching t-codex-real-smoke.bats's contract.

load '../../helpers/setup'
load '../../helpers/codex-zero'

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-codex-byok-${UNIQUE_ID}"

    # 1. Feature switch on (also fails the file early if not yet wired)
    enable_codex_beta

    # 2. Org-level openai-api-key provider — picked up as default by eager-pin
    $ZERO_CLI org model-provider setup --type "openai-api-key" --secret "$OPENAI_API_KEY" >/dev/null

    # 3. Minimal compose: NO framework / model_provider declared. Eager-pin
    # (#11528) inherits the org-default openai-api-key → codex framework.
    # This is the precise behavior validated end-to-end.
    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "BYOK codex zero web smoke test"
    working_dir: /home/user/workspace
EOF

    local compose_json
    compose_json=$($VM0_CLI compose "$TEST_DIR/vm0-basic.yaml" --json)
    export AGENT_ID
    AGENT_ID=$(printf '%s' "$compose_json" | jq -r '.composeId')
    [[ -n "$AGENT_ID" && "$AGENT_ID" != "null" ]] \
        || { echo "# compose --json output: $compose_json" >&2; return 1; }
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
    # Send a deterministic prompt; this also creates the thread.
    run $ZERO_CLI chat message send \
        --agent "$AGENT_ID" \
        --text "Compute 123+456 and reply with exactly: RESULT=<answer>"
    assert_success

    # Output: "✓ Message sent (id: <msg-id>, thread: <thread-id>)"
    THREAD_ID=$(echo "$output" | grep -oP 'thread:\s*\K[a-f0-9-]+' | head -1)
    [[ -n "$THREAD_ID" ]] || fail "Could not parse thread id from: $output"
    export THREAD_ID

    # Wait for the assistant message to terminate. Sets LAST_RUN_ID + LAST_MSG_CONTENT.
    run wait_for_chat_assistant_done "$THREAD_ID"
    assert_success

    # Assert: real codex produced the expected sentinel.
    [[ "$LAST_MSG_CONTENT" == *"RESULT=579"* ]] \
        || fail "Expected 'RESULT=579' in assistant content, got: $LAST_MSG_CONTENT"

    # Assert: thread is eager-pinned (#11528) to the openai-api-key BYOK
    # provider. This proves the compose's missing model_provider was
    # filled in by the org default and that the openai-api-key → codex
    # routing chain resolved end-to-end. (We can't read the runtime
    # framework directly because it isn't projected on /runs/:id and the
    # telemetry route derives it from compose.agents.*.framework which
    # this compose intentionally omits.)
    provider_type=$(get_thread_provider_type "$THREAD_ID")
    [[ "$provider_type" == "openai-api-key" ]] \
        || fail "Expected latestSessionProviderType=openai-api-key, got: $provider_type (thread=$THREAD_ID)"
}
