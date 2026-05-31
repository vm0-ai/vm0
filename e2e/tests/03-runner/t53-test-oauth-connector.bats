#!/usr/bin/env bats

# Test: end-to-end mid-run OAuth token refresh via the synthetic test-oauth
# connector. Covers the pipeline where #9868 lived undetected for months —
# web → runner → mitm → firewall/auth webhook → provider refresh.
#
# Placeholder-injection behavior is already covered for other connector
# shapes in t42 / t43 / t51 (api-token, dynamic-base, auth.query); those
# tests apply equally to OAuth connectors, no need to duplicate here.
#
# Steps:
# 1. Compose an agent that references TEST_OAUTH_TOKEN.
# 2. Connect test-oauth through the real authorization-code OAuth flow.
# 3. Enable the connector for the compose via /api/cli/auth/test-enable-connector
#    so the zero run flow passes it in allowedConnectorTypes.
# 4. Zero-run an agent that curls the echo endpoint. The firewall rule
#    matches any `{pr}.vm6.ai` subdomain; mitm-addon intercepts, the webhook
#    detects expiry, hits the fake provider's refresh grant, injects a fresh
#    Bearer. Echo returns 200 only if the injected token parses as unexpired.

load '../../helpers/setup'

setup_file() {
    if [[ -z "$VM0_API_URL" ]]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi
    # The test-oauth firewall rule matches only `{pr}.vm6.ai` hosts. If
    # VM0_API_URL ever points elsewhere (e.g. a localhost tunnel or a
    # different preview domain), the firewall won't match and the agent's
    # request would pass through to the origin — echo might still respond,
    # silently defeating the mid-run-refresh assertion. Fail early.
    if [[ "$VM0_API_URL" != *.vm6.ai* ]]; then
        echo "VM0_API_URL must be a *.vm6.ai host for the test-oauth firewall to match (got: $VM0_API_URL)" >&2
        return 1
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-test-oauth-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-test-oauth-artifact-${UNIQUE_ID}"
    export TEST_OAUTH_PROVIDER_URL="${VM0_API_URL/-www./-api.}"

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null
}

teardown_file() {
    $ZERO_CLI secret delete -y TEST_OAUTH_ACCESS_TOKEN 2>/dev/null || true
    $ZERO_CLI secret delete -y TEST_OAUTH_REFRESH_TOKEN 2>/dev/null || true

    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

encode_test_email() {
    if [[ -z "${E2E_RUNNER_EMAIL:-}" ]]; then
        echo "E2E_RUNNER_EMAIL not set" >&2
        return 1
    fi
    printf '%s' "$E2E_RUNNER_EMAIL" | sed 's/+/%2B/g; s/@/%40/g'
}

enable_test_oauth_feature_switch() {
    zero_curl "/api/zero/feature-switches" \
        -X POST \
        -d '{"switches":{"testOauthConnector":true}}' \
        >/dev/null
}

# Enable the test-oauth connector for a specific compose (user_connectors row).
# Required for zero-run to pass it in allowedConnectorTypes.
enable_test_oauth_for_compose() {
    local compose_id="$1"

    local encoded_email
    encoded_email=$(encode_test_email) || return 1

    local body
    body=$(cat <<EOF
{"composeId":"${compose_id}","connectorTypes":["test-oauth"]}
EOF
)

    local curl_args=(-s -w "\n%{http_code}" -X POST)
    curl_args+=(-H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "$body")

    local response http_code resp_body
    response=$(curl "${curl_args[@]}" \
        "${VM0_API_URL}/api/cli/auth/test-enable-connector?email=${encoded_email}")
    http_code=$(echo "$response" | tail -n1)
    resp_body=$(echo "$response" | head -n-1)

    if [[ "$http_code" != "200" ]]; then
        echo "test-enable-connector failed: HTTP $http_code"
        echo "Response: $resp_body"
        return 1
    fi
}

seed_test_oauth_connector() {
    local access_token="$1"
    local refresh_token="$2"
    local expires_in="$3"

    local encoded_email
    encoded_email=$(encode_test_email) || return 1

    local body
    body=$(jq -nc \
        --arg accessToken "$access_token" \
        --arg refreshToken "$refresh_token" \
        --argjson expiresIn "$expires_in" \
        '{
            connectorName: "test-oauth",
            accessToken: $accessToken,
            refreshToken: $refreshToken,
            expiresIn: $expiresIn
        }')

    local curl_args=(-s -w "\n%{http_code}" -X POST)
    curl_args+=(-H "Content-Type: application/json")
    append_test_oauth_bypass_headers curl_args
    curl_args+=(-d "$body")

    local response http_code resp_body
    response=$(curl "${curl_args[@]}" \
        "${VM0_API_URL}/api/cli/auth/test-connector?email=${encoded_email}")
    http_code=$(echo "$response" | tail -n1)
    resp_body=$(echo "$response" | head -n-1)

    if [[ "$http_code" != "200" ]]; then
        echo "test-connector failed: HTTP $http_code"
        echo "Response: $resp_body"
        return 1
    fi
}

append_test_oauth_bypass_headers() {
    local -n headers_ref="$1"
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers_ref+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
        headers_ref+=(-H "x-vm0-test-endpoint-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
}

header_location() {
    local header_file="$1"
    grep -i '^location:' "$header_file" | head -n1 | sed -E 's/^[Ll]ocation:[[:space:]]*//; s/\r$//'
}

connect_test_oauth_via_authorization_code() {
    local scenario="${1:-}"
    enable_test_oauth_feature_switch || return 1

    local start_body
    start_body=$(zero_curl "/api/zero/connectors/test-oauth/oauth/start" -X POST -d '{"authMethod":"oauth"}')
    local authorization_url
    authorization_url=$(printf '%s' "$start_body" | jq -r '.authorizationUrl // empty')
    [ -n "$authorization_url" ] || {
        echo "# Missing authorizationUrl from OAuth start response"
        echo "$start_body"
        return 1
    }
    if [[ -n "$scenario" ]]; then
        authorization_url="${authorization_url}&scenario=${scenario}"
    fi

    local authorize_headers="$BATS_FILE_TMPDIR/test-oauth-authorize.headers"
    local authorize_body="$BATS_FILE_TMPDIR/test-oauth-authorize.body"
    local curl_args=(-sS -D "$authorize_headers" -o "$authorize_body" -w "%{http_code}")
    append_test_oauth_bypass_headers curl_args
    local authorize_status
    authorize_status=$(curl "${curl_args[@]}" "$authorization_url")
    if [[ "$authorize_status" != "302" ]]; then
        echo "# test-oauth authorize returned HTTP $authorize_status"
        cat "$authorize_body"
        return 1
    fi

    local callback_url
    callback_url=$(header_location "$authorize_headers")
    [ -n "$callback_url" ] || {
        echo "# Missing callback Location from test-oauth authorize response"
        cat "$authorize_headers"
        return 1
    }

    local callback_headers="$BATS_FILE_TMPDIR/test-oauth-callback.headers"
    local callback_body="$BATS_FILE_TMPDIR/test-oauth-callback.body"
    curl_args=(-sS -D "$callback_headers" -o "$callback_body" -w "%{http_code}")
    append_test_oauth_bypass_headers curl_args
    local callback_status
    callback_status=$(curl "${curl_args[@]}" "$callback_url")
    if [[ "$callback_status" != "307" ]]; then
        echo "# test-oauth callback returned HTTP $callback_status"
        cat "$callback_body"
        return 1
    fi

    local success_url
    success_url=$(header_location "$callback_headers")
    [ -n "$success_url" ] || {
        echo "# Missing success Location from test-oauth callback response"
        cat "$callback_headers"
        return 1
    }
    [[ "$success_url" == *"/connector/success"* && "$success_url" == *"type=test-oauth"* ]] || {
        echo "# Callback did not redirect to test-oauth success URL"
        echo "$success_url"
        return 1
    }
}

@test "test-oauth: mid-run token refresh through proxy" {
    # Connect with a short-lived token. The callback succeeds because the token
    # is still valid for userinfo, and the webhook refreshes it later because
    # its DB expiry is inside the refresh buffer.
    run connect_test_oauth_via_authorization_code "short-lived-access"
    echo "$output"
    assert_success

    cat > "$TEST_DIR/vm0-refresh.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-refresh:
    description: "test-oauth mid-run refresh"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      TEST_OAUTH_TOKEN: \${{ secrets.TEST_OAUTH_TOKEN }}
EOF

    run $VM0_CLI compose --yes --json "$TEST_DIR/vm0-refresh.yaml"
    echo "$output"
    assert_success

    local COMPOSE_ID
    COMPOSE_ID=$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)['composeId'])")
    [ -n "$COMPOSE_ID" ] || {
        echo "# Failed to extract composeId from compose output"
        return 1
    }

    run enable_test_oauth_for_compose "$COMPOSE_ID"
    echo "$output"
    assert_success

    # Agent curls the echo endpoint. The proxy should intercept, refresh
    # the expired token, and inject a fresh Bearer. Echo validates the
    # token's baked-in expiry and returns 200 only if it's fresh.
    # The echo route is API-authoritative. Hit the API preview alias directly
    # so this test continues to exercise sandbox firewall/mitm token refresh
    # without depending on Next external rewrites to preserve preview guard
    # headers. The web-to-api rewrite is covered by web rewrite tests.
    run $ZERO_CLI run "$COMPOSE_ID" \
        "STATUS=\$(curl -s -o /tmp/echo-body -w '%{http_code}' -H 'x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}' -H 'x-vm0-test-endpoint-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}' '${TEST_OAUTH_PROVIDER_URL}/api/test/oauth-provider/echo') && echo \"ECHO_STATUS=\$STATUS\" && echo \"ECHO_BODY=\$(cat /tmp/echo-body)\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # 200 proves the proxy matched + refresh path injected a fresh, unexpired token.
    assert_output --partial "ECHO_STATUS=200"

    # The echoed Authorization must be a fresh testoauth_at_<unix_ms>_<hex>
    # minted by the fake provider's refresh grant.
    assert_output --regexp "ECHO_BODY=.*testoauth_at_[0-9]+_[a-f0-9]+"

    # Extract Run ID and confirm the proxy (a) matched test-oauth firewall
    # and (b) ACTUALLY refreshed the access token. CLI `logs --network`
    # renders `auth_refreshed_secrets` as "<SECRET_NAME> (refreshed)" inline
    # (see turbo/apps/cli/src/commands/logs/index.ts:formatAuthInfo).
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }
    wait_for_log "$RUN_ID" --network -- \
        "[test-oauth]" "TEST_OAUTH_TOKEN (refreshed)"
}

@test "test-oauth: stored token expired but DB says fresh — echo 401s" {
    run connect_test_oauth_via_authorization_code
    echo "$output"
    assert_success

    # The stored access token embeds a past unix-ms expiry but DB
    # tokenExpiresAt is in the future (expiresIn=3600), so the firewall/auth
    # webhook trusts the DB and does NOT refresh. mitm injects the stored
    # token into the request and echo's own expiry check catches the drift,
    # returning 401 with "expired_token". Proves the echo route's
    # self-validation guards against webhook-side staleness bugs.
    # After the real OAuth callback, use the test-only seed endpoint to create
    # this intentionally inconsistent connector-secret state.
    local past_ms=$(( ( $(date +%s) - 3600 ) * 1000 ))
    run seed_test_oauth_connector \
        "testoauth_at_${past_ms}_staleaccesstoken" \
        "testoauth_rt_success_stalerefreshtoken" \
        3600
    echo "$output"
    assert_success

    cat > "$TEST_DIR/vm0-stale.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-stale:
    description: "test-oauth stale access token (DB drift)"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      TEST_OAUTH_TOKEN: \${{ secrets.TEST_OAUTH_TOKEN }}
EOF

    run $VM0_CLI compose --yes --json "$TEST_DIR/vm0-stale.yaml"
    echo "$output"
    assert_success

    local COMPOSE_ID
    COMPOSE_ID=$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)['composeId'])")
    [ -n "$COMPOSE_ID" ] || {
        echo "# Failed to extract composeId from compose output"
        return 1
    }

    run enable_test_oauth_for_compose "$COMPOSE_ID"
    echo "$output"
    assert_success

    run $ZERO_CLI run "$COMPOSE_ID" \
        "STATUS=\$(curl -s -o /tmp/echo-body -w '%{http_code}' -H 'x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}' -H 'x-vm0-test-endpoint-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}' '${TEST_OAUTH_PROVIDER_URL}/api/test/oauth-provider/echo') && echo \"ECHO_STATUS=\$STATUS\" && echo \"ECHO_BODY=\$(cat /tmp/echo-body)\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Webhook trusted DB (future expiry) → no refresh → stored stale token
    # reaches echo → echo's own expiry check rejects it.
    assert_output --partial "ECHO_STATUS=401"
    assert_output --partial "expired_token"

    # Confirm the webhook DID NOT refresh. ECHO_STATUS=401 alone would also
    # fire if refresh failed with a server error and a stale/empty token got
    # injected; the "(refreshed)" tag is the discriminating signal. The
    # wait_for_log call also guarantees [test-oauth] appeared in the log —
    # if it times out, bats aborts the test on its non-zero exit.
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }
    wait_for_log "$RUN_ID" --network -- "[test-oauth]"
    assert_output --partial "[test-oauth]"
    refute_output --partial "TEST_OAUTH_TOKEN (refreshed)"
}
