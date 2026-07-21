#!/usr/bin/env bats

# Verify firewall_billable propagation through the full stack.
#
# BYOK selection uses the runner provider-type path so chat writes do not carry
# provider pins. The vm0 case exercises the web chat model-only path and relies
# on org model policy for provider resolution.
#
# t54-0: direct run with org BYOK anthropic-api-key; "$" marker absent.
# t54-1: chat run uses the model policy's vm0 route; billableFirewalls covers
#   the concrete anthropic firewall → "$" marker present.

load '../../helpers/setup'

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set — required for real Claude calls"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export RUN_AGENT_NAME="e2e-billable-runner-${UNIQUE_ID}"
    export THREAD_IDS=""

    $ZERO_CLI org model-provider setup \
        --type anthropic-api-key \
        --secret "$ANTHROPIC_API_KEY" >/dev/null
    zero_model_provider_id_by_type "anthropic-api-key" >/dev/null

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${RUN_AGENT_NAME}:
    description: "Billable firewall BYOK e2e"
    framework: claude-code
    environment:
      ANTHROPIC_MODEL: "claude-sonnet-4-6"
EOF

    seed_compose_fixture "$TEST_DIR/vm0.yaml" >/dev/null

    # Create a private zero agent for this file so CI does not consume the
    # shared org's limited public-agent slots.
    local create_out
    create_out=$(zero_curl "/api/zero/agents" \
        -X POST \
        --data "$(jq -nc \
            --arg displayName "e2e-billable-${UNIQUE_ID}" \
            '{displayName: $displayName, visibility: "private"}')")
    export AGENT_ID
    AGENT_ID=$(echo "$create_out" | jq -r '.agentId // empty')
    [ -n "$AGENT_ID" ] || {
        echo "# Failed to extract Agent ID from: $create_out" >&2
        return 1
    }
}

teardown_file() {
    for thread_id in $THREAD_IDS; do
        zero_curl "/api/zero/chat-threads/$thread_id" -X DELETE >/dev/null 2>&1 || true
    done
    [ -n "$AGENT_ID" ] && $ZERO_CLI agent delete "$AGENT_ID" -y 2>/dev/null || true
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t54-0: BYOK provider — firewall not billable" {
    run run_compose_fixture "$RUN_AGENT_NAME" \
        "Reply with exactly: DONE" \
        '{"modelProviderType":"anthropic-api-key","realAgentInPreview":true}'

    echo "$output"
    assert_success

    RUN_ID=$(run_fixture_field "$output" '.runId')
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    WAIT_FOR_LOG_TIMEOUT=60 wait_for_log "$RUN_ID" --network -- "[model-provider:anthropic-api-key]"
    refute_output --partial '[model-provider:anthropic-api-key $]'

    usage_body=$(zero_usage_runs_response "$RUN_ID")
    assert_equal "$(printf '%s' "$usage_body" | jq -r '.runs | length')" "0"
}

@test "t54-1: vm0 meta-provider — firewall billable" {
    zero_chat_run_with_model \
        "$AGENT_ID" \
        "Reply with exactly: DONE" \
        "claude-sonnet-4-6" \
        true
    THREAD_IDS="$THREAD_IDS $LAST_THREAD_ID"
    export THREAD_IDS

    RUN_ID="$LAST_RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_zero_run_completed "$RUN_ID"
    WAIT_FOR_LOG_TIMEOUT=60 wait_for_log "$RUN_ID" --network -- '[model-provider:anthropic-api-key $]'

    usage_run=$(wait_for_zero_usage_run "$RUN_ID")
    assert_equal "$(printf '%s' "$usage_run" | jq -r '.runId')" "$RUN_ID"
    assert_equal "$(printf '%s' "$usage_run" | jq -r '.model')" "claude-sonnet-4-6"
    jq -e '.inputTokens > 0' <<<"$usage_run" >/dev/null
    jq -e '.outputTokens > 0' <<<"$usage_run" >/dev/null
    jq -e '.creditsCharged > 0' <<<"$usage_run" >/dev/null
}
