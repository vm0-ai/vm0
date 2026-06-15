#!/usr/bin/env bats

# API-only smoke for the synthetic OAuth device authorization connector.
# This intentionally avoids browser, runner, sandbox, and firewall behavior.

load '../../helpers/setup'

export BATS_TEST_TIMEOUT=30

setup_file() {
    local token base
    if ! token=$(zero_auth_token 2>/dev/null) || [[ -z "$token" ]]; then
        skip "Zero auth token not configured"
    fi
    if ! base=$(zero_api_url 2>/dev/null) || [[ -z "$base" ]]; then
        skip "Zero API URL not configured"
    fi
}

zero_api_request() {
    local method="$1"
    local path="$2"
    local body="${3:-}"
    local token base curl_status

    token=$(zero_auth_token)
    base=$(zero_api_url)
    LAST_RESPONSE_BODY="$BATS_TEST_TMPDIR/zero-api-${BATS_TEST_NUMBER}-${RANDOM}.json"

    local -a headers=(
        -H "Authorization: Bearer $token"
        -H "Accept: application/json"
        -H "Content-Type: application/json"
    )
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi

    local -a args=(
        -sS
        --max-time 30
        -o "$LAST_RESPONSE_BODY"
        -w "%{http_code}"
        -X "$method"
        "${headers[@]}"
    )
    if [[ -n "$body" ]]; then
        args+=(-d "$body")
    fi

    LAST_HTTP_STATUS=$(curl "${args[@]}" "${base%/}${path}")
    curl_status=$?
    if [[ "$curl_status" -ne 0 ]]; then
        echo "# $method $path curl failed with exit $curl_status" >&2
        if [[ -s "$LAST_RESPONSE_BODY" ]]; then
            echo "# response body: $(cat "$LAST_RESPONSE_BODY")" >&2
        fi
        return 1
    fi
}

assert_api_status() {
    local expected="$1"
    local label="$2"
    if [[ "$LAST_HTTP_STATUS" != "$expected" ]]; then
        echo "# $label returned HTTP $LAST_HTTP_STATUS, expected $expected" >&2
        echo "# response body: $(cat "$LAST_RESPONSE_BODY")" >&2
        return 1
    fi
}

assert_response_jq() {
    local filter="$1"
    local label="$2"
    if ! jq -e "$filter" "$LAST_RESPONSE_BODY" >/dev/null; then
        echo "# $label returned unexpected payload" >&2
        echo "# jq filter: $filter" >&2
        echo "# response body: $(cat "$LAST_RESPONSE_BODY")" >&2
        return 1
    fi
}

@test "test-oauth-device: API device authorization creates a connector" {
    zero_api_request POST \
        "/api/zero/feature-switches" \
        '{"switches":{"testOauthConnector":true}}'
    assert_api_status 200 "feature switch update"
    assert_response_jq '.switches.testOauthConnector == true' "feature switch update"

    zero_api_request POST \
        "/api/zero/connectors/test-oauth-device/oauth/device/sessions" \
        '{"authMethod":"oauth"}'
    assert_api_status 200 "device authorization start"
    assert_response_jq '
      .status == "pending" and
      .type == "test-oauth-device" and
      .userCode == "TEST-DEVICE" and
      .verificationUri == "https://oauth-device.test/device" and
      .verificationUriComplete == "https://oauth-device.test/device?user_code=TEST-DEVICE" and
      .interval == 0 and
      (.sessionId | type == "string" and length > 0) and
      (.sessionToken | type == "string" and length > 0)
    ' "device authorization start"

    local session_id session_token poll_body
    session_id=$(jq -r '.sessionId' "$LAST_RESPONSE_BODY")
    session_token=$(jq -r '.sessionToken' "$LAST_RESPONSE_BODY")
    poll_body=$(jq -nc --arg sessionToken "$session_token" '{sessionToken: $sessionToken}')

    zero_api_request POST \
        "/api/zero/connectors/test-oauth-device/oauth/device/sessions/${session_id}/poll" \
        "$poll_body"
    assert_api_status 200 "device authorization poll"
    assert_response_jq '
      .status == "complete" and
      .connector.type == "test-oauth-device" and
      .connector.authMethod == "oauth" and
      .connector.externalUsername == "test-oauth-device-user"
    ' "device authorization poll"

    zero_api_request GET "/api/zero/connectors"
    assert_api_status 200 "connector list"
    assert_response_jq '
      any(.connectors[]?; .type == "test-oauth-device" and
        .authMethod == "oauth" and
        .externalUsername == "test-oauth-device-user")
    ' "connector list"
}
