#!/usr/bin/env bats

# Test model-provider credential injection into container environment
#
# Verifies that an explicit model-first provider pin is honored by zero run and
# injected into the container as CLAUDE_CODE_OAUTH_TOKEN.

load '../../helpers/setup'

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_ID=""
    export THREAD_ID=""
}

teardown() {
    [ -n "$THREAD_ID" ] && zero_curl "/api/zero/chat-threads/$THREAD_ID" -X DELETE >/dev/null 2>&1 || true
    [ -n "$AGENT_ID" ] && $ZERO_CLI agent delete "$AGENT_ID" 2>/dev/null || true
}

@test "model-provider credential is injected into container" {
    local provider_id create_out
    provider_id=$(zero_model_provider_id_by_type "claude-code-oauth-token")

    create_out=$($ZERO_CLI agent create --display-name "e2e-mp-inject-${UNIQUE_ID}")
    AGENT_ID=$(echo "$create_out" | grep -oP 'Agent ID:\s+\K[a-f0-9-]{36}')
    [ -n "$AGENT_ID" ] || {
        echo "# Failed to extract Agent ID from: $create_out" >&2
        return 1
    }

    zero_chat_run_with_model_selection \
        "$AGENT_ID" \
        "echo INJECTED=\$CLAUDE_CODE_OAUTH_TOKEN" \
        "$provider_id" \
        "claude-sonnet-4-6" \
        false \
        false
    THREAD_ID="$LAST_THREAD_ID"

    # Token is replaced with a firewall placeholder (proxy injects real token at runtime).
    WAIT_FOR_LOG_TIMEOUT=60 wait_for_log "$LAST_RUN_ID" -- "INJECTED=sk-ant-oat01-CoffeeSafeLocal"
    assert_output --partial "INJECTED=sk-ant-oat01-CoffeeSafeLocal"
}
