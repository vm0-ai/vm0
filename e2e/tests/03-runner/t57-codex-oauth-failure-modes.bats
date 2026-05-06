#!/usr/bin/env bats

# E2E tests for ChatGPT-OAuth failure modes — feature-switch off + stale
# provider blocks runs.
# Issue #11941, parent Epic #11872.
#
# Tests covered:
#   t57-1: connect endpoint returns 404 when feature switch off (Test 6)
#   t57-2: server-side run dispatch rejected when needsReconnect=true
#          (server-side portion of Test 4 — Wave 3 #11932 dependency)
#
# Test 5 (free-plan rejection at OAuth callback) requires MSW-style
# intercepts of auth.openai.com which don't fit the bats / sandbox-runtime
# split. The free-plan rejection is unit-tested in #11876
# (codex-oauth.test.ts) where MSW is the right tool.

load '../../helpers/setup'
load '../../helpers/codex-oauth-setup'

setup_file() {
    if [ -z "$VM0_API_URL" ]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi
}

@test "t57-1: connect endpoint returns 404 when feature switch off" {
    local token
    token=$(codex_oauth_feature_off_token)
    if [ -z "$token" ]; then
        skip "no auth token available — VM0_TEST_TOKEN/ZERO_TOKEN/VM0_TOKEN not set and ~/.vm0/config.json absent"
    fi

    # The registry can enable staff orgs by identity hash; write an explicit
    # false override against the serial E2E user when available. Runner E2E
    # chunks run in parallel, so this negative-path probe must not flip the
    # shared runner user's switch while t54/t55 may be using it.
    force_disable_codex_oauth_provider "$token"

    local curl_args=(-s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $token")
    if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi

    local code
    code=$(curl "${curl_args[@]}" "${VM0_API_URL}/api/zero/chatgpt/oauth/connect")

    # The endpoint MUST return 404 (not 403) when the user is ineligible —
    # isCodexOauthEligible returns false, route emits NotFound. This
    # keeps the entire surface hidden from production users.
    if [ "$code" != "404" ]; then
        disable_codex_oauth_provider "$token"
        echo "Expected 404, got $code" >&2
        return 1
    fi

    disable_codex_oauth_provider "$token"
}

# Test 4 server-side portion. Requires Wave 3 (#11932): the runner guard
# that rejects sandbox dispatch when model_providers.needsReconnect=true.
# Until #11932 ships, this test skips via the runtime probe.
@test "t57-2: codex run rejected when codex-oauth provider needsReconnect=true" {
    if ! codex_oauth_stale_supported; then
        skip "Wave 3 (#11932) features not yet shipped — needsReconnect not surfaced in API"
    fi

    enable_codex_oauth_provider

    local unique_id="$(date +%s%3N)-$RANDOM"
    local agent_name="e2e-chatgpt-stale-${unique_id}"
    local test_dir
    test_dir=$(mktemp -d)

    # Seed provider already in stale state. Wave 3's runner guard reads
    # this on dispatch and rejects before spawning the sandbox.
    seed_codex_oauth "stale-at" "stale-rt" "ws_stale" "id-tok" 600 true "refresh_token_expired"

    cat > "$test_dir/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "ChatGPT OAuth stale-rejection test"
    framework: codex
    environment:
      OPENAI_API_KEY: "ignored-when-using-codex-oauth-token-provider"
    working_dir: /home/user/workspace
EOF
    $VM0_CLI compose "$test_dir/vm0.yaml" >/dev/null

    run $VM0_CLI run "$agent_name" -- "test"

    # Run MUST fail with a stale-provider signal. Tolerant to the exact
    # error code/message shape Wave 3 ships — match on any of:
    #   - "Re-connect" / "reconnect" CTA copy
    #   - StaleProviderError class name
    #   - needsReconnect field reference
    #   - refresh_token_expired surfaced to user
    assert_failure
    if echo "$output" | grep -qiE "re-?connect|StaleProvider|needsReconnect|refresh_token_expired"; then
        :
    else
        echo "Expected stale-provider error message; full output:" >&2
        echo "$output" >&2
        fail "Run was rejected but the error doesn't reference a stale-provider condition"
    fi

    rm -rf "$test_dir"
    disable_codex_oauth_provider
}
