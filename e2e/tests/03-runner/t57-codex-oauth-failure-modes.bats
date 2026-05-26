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

# Note: t57-1 (connect endpoint returns 404 when feature switch off) was
# removed in this PR. The /api/zero/chatgpt/oauth/connect route is deleted
# by sub-issue #11979 (Wave 2), at which point the 404 is trivially true
# (no route exists) and the test loses meaning. Feature-gating is now
# tested at the paste-modal eligibility level (Playwright) and at the
# parser-rejection level (the t57-paste-* tests below).

# Helper: build an id_token JWT-shaped string with a `chatgpt_plan_type`
# claim. The body is base64url-encoded but uses a non-base64 signature so
# Semgrep's JWT detection rule does not match the fixture (existing
# pattern from t54-codex-oauth-sandbox.bats).
_make_id_token_with_plan() {
    local plan="$1"
    local payload
    payload=$(jq -n --arg p "$plan" \
        '{"https://api.openai.com/auth": {chatgpt_plan_type: $p, chatgpt_account_id: "test-acc"}}' \
        | base64 -w0 \
        | tr '+/' '-_' \
        | tr -d '=')
    printf 'hdr.%s.sig' "$payload"
}

@test "t57-paste-malformed-json: paste with invalid JSON returns 400 shape error" {
    if [ -z "${E2E_PASTE_FLOW_ENABLED:-}" ]; then
        skip "Paste flow not yet wired (sub-issue #11980 pending)"
    fi
    if ! codex_oauth_paste_supported; then
        skip "Test endpoint authJson variant unavailable; #11978 parser missing"
    fi

    local body='{"authJson":"not valid json {"}'
    local resp http_code resp_body
    resp=$(_post_test_codex_oauth "$body")
    http_code=$(echo "$resp" | tail -n1)
    resp_body=$(echo "$resp" | head -n-1)

    if [ "$http_code" != "400" ]; then
        echo "Expected 400, got $http_code" >&2
        echo "Response: $resp_body" >&2
        return 1
    fi
    # #11978 parser returns "auth.json shape invalid: <reason>"
    echo "$resp_body" | jq -e '.error | startswith("auth.json shape invalid")' >/dev/null
}

@test "t57-paste-missing-refresh-token: paste with missing refresh_token returns 400 shape error" {
    if [ -z "${E2E_PASTE_FLOW_ENABLED:-}" ]; then
        skip "Paste flow not yet wired (sub-issue #11980 pending)"
    fi
    if ! codex_oauth_paste_supported; then
        skip "Test endpoint authJson variant unavailable; #11978 parser missing"
    fi

    # Auth.json shape with only access_token + account_id + id_token; the
    # parser must reject because refresh_token is required for the firewall
    # refresh pipeline.
    local raw_json
    raw_json=$(jq -n \
        '{OPENAI_API_KEY: null, tokens: {access_token: "at", account_id: "ai", id_token: "hdr.payload.sig"}}')
    local body
    body=$(jq -n --arg aj "$raw_json" '{authJson: $aj}')

    local resp http_code resp_body
    resp=$(_post_test_codex_oauth "$body")
    http_code=$(echo "$resp" | tail -n1)
    resp_body=$(echo "$resp" | head -n-1)

    if [ "$http_code" != "400" ]; then
        echo "Expected 400, got $http_code" >&2
        echo "Response: $resp_body" >&2
        return 1
    fi
    echo "$resp_body" | jq -e '.error | startswith("auth.json shape invalid")' >/dev/null
}

@test "t57-paste-free-plan: paste with free-plan id_token returns 400 free-plan error" {
    if [ -z "${E2E_PASTE_FLOW_ENABLED:-}" ]; then
        skip "Paste flow not yet wired (sub-issue #11980 pending)"
    fi
    if ! codex_oauth_paste_supported; then
        skip "Test endpoint authJson variant unavailable; #11978 parser missing"
    fi

    local id_token
    id_token=$(_make_id_token_with_plan "free")
    local raw_json
    raw_json=$(jq -n --arg it "$id_token" \
        '{OPENAI_API_KEY: null, tokens: {access_token: "at", refresh_token: "rt", account_id: "ai", id_token: $it}}')
    local body
    body=$(jq -n --arg aj "$raw_json" '{authJson: $aj}')

    local resp http_code resp_body
    resp=$(_post_test_codex_oauth "$body")
    http_code=$(echo "$resp" | tail -n1)
    resp_body=$(echo "$resp" | head -n-1)

    if [ "$http_code" != "400" ]; then
        echo "Expected 400, got $http_code" >&2
        echo "Response: $resp_body" >&2
        return 1
    fi
    # #11978 parser returns "Free plan rejected by parser"
    echo "$resp_body" | jq -e '.error | test("[Ff]ree plan")' >/dev/null
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
    working_dir: /home/user/workspace
EOF
    $VM0_CLI compose "$test_dir/vm0.yaml" >/dev/null

    run $VM0_CLI run "$agent_name" \
        --model-provider-type "codex-oauth-token" \
        -- "test"

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
