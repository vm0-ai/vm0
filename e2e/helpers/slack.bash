#!/usr/bin/env bash

# Slack e2e helpers: HMAC-sign webhook payloads and interact with the
# test-state endpoint hosted on the same Vercel preview deployment.
#
# Required env:
#   VM0_API_URL                        — target web app URL
#   SLACK_SIGNING_SECRET               — shared secret the preview is deployed with
#   VERCEL_AUTOMATION_BYPASS_SECRET    — for test-state endpoint on preview

# Source canonical fixture identifiers (kept in sync with
# turbo/apps/web/src/lib/test-endpoints/slack-mock-fixtures.ts).
# shellcheck source=./slack-fixtures.sh
source "$(dirname "${BASH_SOURCE[0]}")/slack-fixtures.sh"

# Polling tunables for wait_for_slack_run. The 60s default accommodates
# Vercel preview cold-starts where the first lambda invocation can take
# 15-20s before the handler begins executing. Override via env for faster
# local iteration against a warm preview.
SLACK_POLL_INTERVAL_S="${SLACK_POLL_INTERVAL_S:-2}"
SLACK_POLL_TIMEOUT_S="${SLACK_POLL_TIMEOUT_S:-60}"

# Populate a named array (passed by reference in BASH 4+ via nameref) with the
# `-H` args required to bypass Vercel preview protection. Empty when the secret
# is unset (local dev).
_slack_bypass_args() {
    local -n _out="$1"
    _out=()
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        _out+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
}

# Compute v0 Slack signature for a given body.
# Usage: slack_sign_body <body>
# Sets: SLACK_TS, SLACK_SIG
slack_sign_body() {
    local body="$1"
    SLACK_TS="$(date +%s)"
    local basestring="v0:${SLACK_TS}:${body}"
    local hex
    hex=$(printf '%s' "$basestring" \
        | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex \
        | awk '{print $NF}')
    SLACK_SIG="v0=${hex}"
    export SLACK_TS SLACK_SIG
}

# POST a /vm0 slash command to the Slack commands endpoint.
# Usage: slack_post_command <command> <text> <team_id> <user_id> [channel_id]
# Output: HTTP status code on stderr, response body on stdout
slack_post_command() {
    local command="$1" text="$2" team_id="$3" user_id="$4"
    local channel_id="${5:-$SLACK_FIXTURE_CHANNEL_ID}"
    local body
    body=$(
        printf 'token=xoxb-test&team_id=%s&team_domain=e2e&channel_id=%s&channel_name=e2e&user_id=%s&user_name=e2e-user&command=%s&text=%s&api_app_id=%s' \
            "$team_id" "$channel_id" "$user_id" "$command" "$text" "$SLACK_FIXTURE_APP_ID"
    )
    slack_sign_body "$body"
    local -a bypass=()
    _slack_bypass_args bypass
    curl -sS -X POST \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -H "x-slack-request-timestamp: $SLACK_TS" \
        -H "x-slack-signature: $SLACK_SIG" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_URL/api/zero/slack/commands"
}

# POST a JSON Slack event payload to the events endpoint.
# Usage: slack_post_event <json_body>
slack_post_event() {
    local body="$1"
    slack_sign_body "$body"
    local -a bypass=()
    _slack_bypass_args bypass
    curl -sS -X POST \
        -H "Content-Type: application/json" \
        -H "x-slack-request-timestamp: $SLACK_TS" \
        -H "x-slack-signature: $SLACK_SIG" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_URL/api/zero/slack/events"
}

# Fetch the test-state endpoint output as JSON.
# Usage: slack_fetch_state <team_id>
slack_fetch_state() {
    local team_id="$1"
    local -a bypass=()
    _slack_bypass_args bypass
    curl -sS "${bypass[@]}" \
        "$VM0_API_URL/api/test/slack-state?team_id=$team_id"
}

# Seed a Slack installation (and optionally a connection / default agent)
# for the test user.
# Usage: slack_seed_state <team_id> <slack_user_id> [flags...]
#   --with-connection      also create slack_org_connections row
#   --with-default-agent   also seed a compose + zero_agent + set org default
#
# The test user's email is read from E2E_SERIAL_EMAIL (set by CI to match
# the Clerk user provisioned for this run). When unset, the server falls
# back to its own DEFAULT_TEST_EMAIL, which will only exist in local dev.
slack_seed_state() {
    local team_id="$1" slack_user_id="$2"
    shift 2
    local seed_connection="false"
    local seed_default_agent="false"
    for flag in "$@"; do
        case "$flag" in
            --with-connection) seed_connection="true" ;;
            --with-default-agent) seed_default_agent="true" ;;
        esac
    done
    local email="${E2E_SERIAL_EMAIL:-}"
    local body
    body=$(jq -nc \
        --arg team_id "$team_id" \
        --arg slack_user_id "$slack_user_id" \
        --arg email "$email" \
        --argjson seed_connection "$seed_connection" \
        --argjson seed_default_agent "$seed_default_agent" \
        '{team_id: $team_id, slack_user_id: $slack_user_id,
          seed_connection: $seed_connection,
          seed_default_agent: $seed_default_agent}
         + (if $email == "" then {} else {email: $email} end)')
    local -a bypass=()
    _slack_bypass_args bypass
    curl -sS -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_URL/api/test/slack-state"
}

# Delete all Slack state for a workspace.
# Usage: slack_reset_state <team_id>
slack_reset_state() {
    local team_id="$1"
    local -a bypass=()
    _slack_bypass_args bypass
    curl -sS -X DELETE "${bypass[@]}" \
        "$VM0_API_URL/api/test/slack-state?team_id=$team_id" >/dev/null
}

# Poll test-state until `recent_runs` contains at least one entry or timeout.
# Usage: wait_for_slack_run <team_id> [timeout_seconds]
wait_for_slack_run() {
    local team_id="$1"
    local timeout="${2:-$SLACK_POLL_TIMEOUT_S}"
    local elapsed=0
    while (( elapsed < timeout )); do
        local state
        state=$(slack_fetch_state "$team_id")
        local count
        count=$(printf '%s' "$state" | jq -r '.recent_runs | length')
        if [[ "$count" -gt 0 ]]; then
            return 0
        fi
        sleep "$SLACK_POLL_INTERVAL_S"
        (( elapsed += SLACK_POLL_INTERVAL_S ))
    done
    echo "# wait_for_slack_run: timed out after ${timeout}s for team $team_id" >&2
    echo "# last state: $(slack_fetch_state "$team_id")" >&2
    return 1
}

# Substitute common placeholders in a JSON fixture file.
# Usage: slack_render_fixture <path> <team_id> <channel_id> <user_id> [extra_ts]
slack_render_fixture() {
    local path="$1" team_id="$2" channel_id="$3" user_id="$4"
    local ts="${5:-$(date +%s).000100}"
    sed \
        -e "s/{{TEAM_ID}}/$team_id/g" \
        -e "s/{{CHANNEL_ID}}/$channel_id/g" \
        -e "s/{{USER_ID}}/$user_id/g" \
        -e "s/{{TS}}/$ts/g" \
        "$path"
}
