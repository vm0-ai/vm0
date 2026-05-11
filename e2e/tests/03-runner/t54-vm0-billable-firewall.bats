#!/usr/bin/env bats

# Verify firewall_billable propagation through the full stack.
#
# Uses `zero run --model-provider` for per-run provider selection. The test
# keeps the real zero-agent creation path because it exercises the same compose
# metadata and environment defaults as user-created agents.
#
# t54-0: no override; resolver uses bootstrap claude-code-oauth-token default.
#   Mock token 401s upstream but the firewall tag is stamped; "$" marker absent.
# t54-1: --model-provider vm0 → concrete anthropic-api-key (fake pool key →
#   401), billableFirewalls covers the firewall → "$" marker present.

load '../../helpers/setup'

cleanup_stale_billable_agents() {
    local agents_out
    agents_out=$($ZERO_CLI agent list 2>/dev/null || true)

    echo "$agents_out" | awk '$0 ~ /e2e-billable-/ { print $1 }' | while read -r agent_id; do
        [ -n "$agent_id" ] || continue
        $ZERO_CLI agent delete "$agent_id" --yes >/dev/null 2>&1 || true
    done
}

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set — required for real Claude calls"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    cleanup_stale_billable_agents

    # Ensure vm0 provider coexists with bootstrap claude-code-oauth-token.
    # CLI non-interactive mode requires --secret; the API route detects
    # type === "vm0" and routes to the no-secret upsert, ignoring it.
    $ZERO_CLI org model-provider setup \
        --type vm0 \
        --secret unused-vm0-is-no-secret \
        --model claude-sonnet-4-6 >/dev/null

    local create_out
    create_out=$($ZERO_CLI agent create --display-name "e2e-billable-${UNIQUE_ID}")
    export AGENT_ID
    AGENT_ID=$(echo "$create_out" | grep -oP 'Agent ID:\s+\K[a-f0-9-]{36}')
    [ -n "$AGENT_ID" ] || {
        echo "# Failed to extract Agent ID from: $create_out" >&2
        return 1
    }
}

teardown_file() {
    [ -n "$AGENT_ID" ] && $ZERO_CLI agent delete "$AGENT_ID" --yes 2>/dev/null || true
    $ZERO_CLI org model-provider remove vm0 2>/dev/null || true
}

@test "t54-0: bootstrap provider — firewall not billable" {
    run $ZERO_CLI run "$AGENT_ID" \
        --debug-no-mock-claude \
        "Reply with exactly: DONE"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- "[model-provider:claude-code-oauth-token]"
    refute_output --partial '[model-provider:claude-code-oauth-token $]'
}

@test "t54-1: vm0 meta-provider — firewall billable" {
    run $ZERO_CLI run "$AGENT_ID" \
        --model-provider vm0 \
        --debug-no-mock-claude \
        "Reply with exactly: DONE"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- '[model-provider:anthropic-api-key $]'
}
