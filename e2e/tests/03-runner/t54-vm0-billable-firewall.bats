#!/usr/bin/env bats

# Verify firewall_billable propagation through the full stack.
#
# Uses `zero run --model-provider` for per-run provider selection. The test
# creates a compose-backed agent instead of a persistent zero agent, so it does
# not depend on the shared e2e org's agent quota.
#
# t54-0: no override; resolver uses bootstrap claude-code-oauth-token default.
#   Mock token 401s upstream but the firewall tag is stamped; "$" marker absent.
# t54-1: --model-provider vm0 → concrete anthropic-api-key (fake pool key →
#   401), billableFirewalls covers the firewall → "$" marker present.

load '../../helpers/setup'
load '../../helpers/codex-zero'

setup_file() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set — required for real Claude calls"
    fi

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-billable-${UNIQUE_ID}"
    export TEST_DIR="$(mktemp -d)"

    # Ensure vm0 provider coexists with bootstrap claude-code-oauth-token.
    # CLI non-interactive mode requires --secret; the API route detects
    # type === "vm0" and routes to the no-secret upsert, ignoring it.
    $ZERO_CLI org model-provider setup \
        --type vm0 \
        --secret unused-vm0-is-no-secret \
        --model claude-sonnet-4-6 >/dev/null

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Billable firewall e2e agent"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    local compose_out
    compose_out=$($VM0_CLI compose --yes --json "$TEST_DIR/vm0.yaml")
    export COMPOSE_ID
    COMPOSE_ID=$(echo "$compose_out" | python3 -c "import sys,json; print(json.load(sys.stdin)['composeId'])")
    [ -n "$COMPOSE_ID" ] || {
        echo "# Failed to extract composeId from: $compose_out" >&2
        return 1
    }

    # Seed the zero_agents row (PK = composeId) without creating a persistent
    # zero agent. vm0 compose only writes agent_composes; zero run requires the
    # lazy metadata upsert path to materialize zero_agents.
    _codex_zero_curl "/api/zero/composes/$COMPOSE_ID/metadata" \
        -X PATCH -d '{"displayName":"Billable firewall e2e"}' >/dev/null
}

teardown_file() {
    [ -n "$TEST_DIR" ] && rm -rf "$TEST_DIR"
    $ZERO_CLI org model-provider remove vm0 2>/dev/null || true
}

@test "t54-0: bootstrap provider — firewall not billable" {
    run $ZERO_CLI run "$COMPOSE_ID" \
        --debug-no-mock-claude \
        "Reply with exactly: DONE"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "$output"
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- "[model-provider:claude-code-oauth-token]"
    refute_output --partial '[model-provider:claude-code-oauth-token $]'
}

@test "t54-1: vm0 meta-provider — firewall billable" {
    run $ZERO_CLI run "$COMPOSE_ID" \
        --model-provider vm0 \
        --debug-no-mock-claude \
        "Reply with exactly: DONE"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "$output"
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- '[model-provider:anthropic-api-key $]'
}
