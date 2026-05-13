#!/usr/bin/env bats

# Verify firewall_billable propagation through the full stack.
#
# Uses explicit model-first pins for provider selection. The test never changes
# the shared e2e org's workspace default, so no race with other chunks.
#
# t54-0: run pinned to org BYOK anthropic-api-key; "$" marker absent.
# t54-1: run uses the model policy's vm0 route; billableFirewalls covers
#   the concrete anthropic firewall → "$" marker present.

load '../../helpers/setup'

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set — required for real Claude calls"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export THREAD_IDS=""

    $ZERO_CLI org model-provider setup \
        --type anthropic-api-key \
        --secret "$ANTHROPIC_API_KEY" >/dev/null
    export ANTHROPIC_PROVIDER_ID
    ANTHROPIC_PROVIDER_ID=$(zero_model_provider_id_by_type "anthropic-api-key")

    # Create a fresh zero agent for this file
    local create_out
    create_out=$($ZERO_CLI agent create --display-name "e2e-billable-${UNIQUE_ID}")
    export AGENT_ID=$(echo "$create_out" | grep -oP 'Agent ID:\s+\K[a-f0-9-]{36}')
    [ -n "$AGENT_ID" ] || {
        echo "# Failed to extract Agent ID from: $create_out" >&2
        return 1
    }
}

teardown_file() {
    for thread_id in $THREAD_IDS; do
        zero_curl "/api/zero/chat-threads/$thread_id" -X DELETE >/dev/null 2>&1 || true
    done
    [ -n "$AGENT_ID" ] && $ZERO_CLI agent delete "$AGENT_ID" 2>/dev/null || true
}

@test "t54-0: BYOK provider — firewall not billable" {
    zero_chat_run_with_model_selection \
        "$AGENT_ID" \
        "Reply with exactly: DONE" \
        "$ANTHROPIC_PROVIDER_ID" \
        "claude-sonnet-4-6" \
        true \
        false
    THREAD_IDS="$THREAD_IDS $LAST_THREAD_ID"
    export THREAD_IDS

    RUN_ID="$LAST_RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    WAIT_FOR_LOG_TIMEOUT=60 wait_for_log "$RUN_ID" --network -- "[model-provider:anthropic-api-key]"
    refute_output --partial '[model-provider:anthropic-api-key $]'
}

@test "t54-1: vm0 meta-provider — firewall billable" {
    zero_chat_run_with_model_selection \
        "$AGENT_ID" \
        "Reply with exactly: DONE" \
        "$(zero_model_first_selection_provider_id)" \
        "claude-sonnet-4-6" \
        true \
        false
    THREAD_IDS="$THREAD_IDS $LAST_THREAD_ID"
    export THREAD_IDS

    RUN_ID="$LAST_RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    WAIT_FOR_LOG_TIMEOUT=60 wait_for_log "$RUN_ID" --network -- '[model-provider:anthropic-api-key $]'
}
