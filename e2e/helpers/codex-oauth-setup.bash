#!/usr/bin/env bash
# Bats helper for seeding codex-oauth-token model_provider state via the
# /api/cli/auth/test-codex-oauth endpoint. Used by E2E tests of the
# ChatGPT-OAuth Codex flow (issue #11941, Epic #11872).

# Encode an email for URL query: "+ → %2B", "@ → %40".
_codex_encode_email() {
    if [ -z "${E2E_RUNNER_EMAIL:-}" ]; then
        echo "E2E_RUNNER_EMAIL not set" >&2
        return 1
    fi
    printf '%s' "$E2E_RUNNER_EMAIL" | sed 's/+/%2B/g; s/@/%40/g'
}

# Seed a codex-oauth-token model provider for E2E tests.
#
# Usage:
#   seed_codex_oauth <access_token> <refresh_token> <account_id> <id_token> [expires_in] [needs_reconnect] [last_refresh_error_code]
#
# expires_in: seconds from now until token expiry (default 600; negative pre-expires).
# needs_reconnect: "true" or "false" (default "false").
# last_refresh_error_code: optional refresh-error code for stale-state simulation.
seed_codex_oauth() {
    local access_token="$1"
    local refresh_token="$2"
    local account_id="$3"
    local id_token="$4"
    local expires_in="${5:-600}"
    local needs_reconnect="${6:-false}"
    local last_refresh_error_code="${7:-}"

    local body
    if [ -n "$last_refresh_error_code" ]; then
        body=$(jq -n \
            --arg at "$access_token" \
            --arg rt "$refresh_token" \
            --arg ai "$account_id" \
            --arg it "$id_token" \
            --argjson ei "$expires_in" \
            --argjson nr "$needs_reconnect" \
            --arg lrec "$last_refresh_error_code" \
            '{accessToken: $at, refreshToken: $rt, accountId: $ai, idToken: $it, expiresIn: $ei, needsReconnect: $nr, lastRefreshErrorCode: $lrec}')
    else
        body=$(jq -n \
            --arg at "$access_token" \
            --arg rt "$refresh_token" \
            --arg ai "$account_id" \
            --arg it "$id_token" \
            --argjson ei "$expires_in" \
            --argjson nr "$needs_reconnect" \
            '{accessToken: $at, refreshToken: $rt, accountId: $ai, idToken: $it, expiresIn: $ei, needsReconnect: $nr}')
    fi

    local encoded_email
    encoded_email=$(_codex_encode_email) || return 1

    local curl_args=(-s -w "\n%{http_code}" -X POST -H "Content-Type: application/json")
    if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "$body")

    local resp http_code resp_body
    resp=$(curl "${curl_args[@]}" "${VM0_API_URL}/api/cli/auth/test-codex-oauth?email=${encoded_email}")
    http_code=$(echo "$resp" | tail -n1)
    resp_body=$(echo "$resp" | head -n-1)

    if [ "$http_code" != "200" ]; then
        echo "test-codex-oauth seed failed: HTTP $http_code" >&2
        echo "Response: $resp_body" >&2
        return 1
    fi
}

# Resolve the auth token for /api/zero/* calls. CI does not export
# VM0_TOKEN/ZERO_TOKEN/VM0_TEST_TOKEN; the cli-e2e-03-runner job copies
# the e2e-runner config to ~/.vm0/config.json instead (turbo.yml line
# 1880, 1952). Fall back to that file the same way _codex_zero_token in
# helpers/codex-zero.bash does, so this helper works in both env-var-
# driven local runs and config-file-driven CI runs.
_codex_oauth_token() {
    if [ -n "${VM0_TEST_TOKEN:-}" ]; then
        printf '%s' "$VM0_TEST_TOKEN"
    elif [ -n "${ZERO_TOKEN:-}" ]; then
        printf '%s' "$ZERO_TOKEN"
    elif [ -n "${VM0_TOKEN:-}" ]; then
        printf '%s' "$VM0_TOKEN"
    elif [ -f "$HOME/.vm0/config.json" ]; then
        jq -r '.token // empty' "$HOME/.vm0/config.json"
    fi
}

# Prefer the serial E2E token for the feature-off probe so runner chunks do
# not race each other by mutating the shared runner user's feature switches.
codex_oauth_feature_off_token() {
    local config="${CODEX_OAUTH_FEATURE_OFF_TOKEN_CONFIG:-/tmp/e2e-token-serial.json}"
    if [ -f "$config" ]; then
        jq -r '.token // empty' "$config"
        return
    fi
    _codex_oauth_token
}

# Set the codexOauthProvider feature switch override for the current test user.
_set_codex_oauth_provider() {
    local enabled="$1"
    local token="${2:-}"
    if [ -z "$token" ]; then
        token=$(_codex_oauth_token)
    fi
    if [ -z "$token" ]; then
        echo "_set_codex_oauth_provider: no auth token (env or ~/.vm0/config.json)" >&2
        return 1
    fi
    local body
    body=$(jq -n --argjson enabled "$enabled" '{switches:{codexOauthProvider:$enabled}}')
    local curl_args=(-fsS -X POST -H "Content-Type: application/json"
        -H "Authorization: Bearer $token"
        -d "$body")
    if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl "${curl_args[@]}" "${VM0_API_URL}/api/zero/feature-switches" >/dev/null
}

# Enable the codexOauthProvider feature switch for the current test user.
# Required so isCodexOauthEligible(orgId, userId) returns true and the
# OAuth connect/callback routes don't 404. The switch is staff-only by
# default, so production users see no surface.
enable_codex_oauth_provider() {
    _set_codex_oauth_provider true "$@"
}

# Force the codexOauthProvider feature switch off for the current test user.
# Clearing overrides is not enough when the static registry enables staff orgs.
force_disable_codex_oauth_provider() {
    local token="${1:-}"
    if [ -z "$token" ]; then
        token=$(codex_oauth_feature_off_token)
    fi
    _set_codex_oauth_provider false "$token"
}

# No-op cleanup for the shared runner user. Runner E2E files run in parallel;
# deleting feature-switch overrides here would clear every switch for the
# shared authenticated user, including codexBeta or codexOauthProvider that
# another file may have enabled moments earlier. Feature-off probes should use
# force_disable_codex_oauth_provider with an isolated token.
disable_codex_oauth_provider() {
    return 0
}

# Common POST helper for /api/cli/auth/test-codex-oauth. Takes a JSON body
# string on stdin or as $1; returns curl exit + sets http_code via a
# nameref-style global. Centralizes email encoding + Vercel bypass header.
_post_test_codex_oauth() {
    local body="$1"
    local encoded_email
    encoded_email=$(_codex_encode_email) || return 1

    local curl_args=(-s -w "\n%{http_code}" -X POST -H "Content-Type: application/json")
    if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "$body")

    curl "${curl_args[@]}" "${VM0_API_URL}/api/cli/auth/test-codex-oauth?email=${encoded_email}"
}

# Seed a codex-oauth-token model provider via the auth_json paste path.
#
# Usage:
#   seed_codex_oauth_via_authjson <raw_auth_json>
#
# raw_auth_json: the codex CLI's auth.json contents (JSON string). The
# server-side parser derives tokenExpiresAt, needsReconnect=false from
# the parsed claims; the legacy seed_codex_oauth helper is the way to
# inject explicit metadata (pre-expired tokens, stale state, etc.).
#
# Returns nonzero if HTTP != 200. Used by the *-paste tests.
seed_codex_oauth_via_authjson() {
    local raw_json="$1"

    local body
    body=$(jq -n --arg aj "$raw_json" '{authJson: $aj}')

    local resp http_code resp_body
    resp=$(_post_test_codex_oauth "$body")
    http_code=$(echo "$resp" | tail -n1)
    resp_body=$(echo "$resp" | head -n-1)

    if [ "$http_code" != "200" ]; then
        echo "test-codex-oauth seed via authJson failed: HTTP $http_code" >&2
        echo "Response: $resp_body" >&2
        return 1
    fi
}

# Probe whether the paste flow (#11978's parser) is wired in the running
# server. Mostly redundant after #11978 merged into main — kept as a
# robust runtime probe so the tests gracefully skip if the test endpoint
# regresses.
#
# Returns 0 if a clearly-invalid authJson POST yields a 400 response.
codex_oauth_paste_supported() {
    local body='{"authJson":"{ not json"}'
    local resp http_code
    resp=$(_post_test_codex_oauth "$body" 2>/dev/null)
    http_code=$(echo "$resp" | tail -n1)

    [ "$http_code" = "400" ]
}

# Probe whether Wave 3 (#11932) features are present. Used to gate Test 4
# (stale recovery) tests so this PR can ship before #11932 merges.
#
# Returns 0 if the model-providers API surface includes `needsReconnect`
# in its response (Wave 3's API widening). Returns 1 otherwise.
codex_oauth_stale_supported() {
    local token
    token=$(_codex_oauth_token)
    if [ -z "$token" ]; then
        return 1
    fi

    local curl_args=(-s -H "Authorization: Bearer $token")
    if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi

    local resp
    resp=$(curl "${curl_args[@]}" "${VM0_API_URL}/api/zero/model-providers" 2>/dev/null)

    # Probe for needsReconnect field on any provider in the response. Schema-
    # level signal is more robust than UI-shape probes.
    echo "$resp" | jq -e 'type == "array" and (.[0] | has("needsReconnect"))' >/dev/null 2>&1
}
