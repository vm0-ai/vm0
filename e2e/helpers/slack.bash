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

_slack_test_endpoint_bypass_args() {
    local -n _out="$1"
    _out=()
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        _out+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
        _out+=(-H "x-vm0-test-endpoint-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
}

_slack_api_backend_url() {
    if [[ -n "${VERCEL_SANDBOX_SMOKE_API_URL:-}" ]]; then
        printf '%s' "$VERCEL_SANDBOX_SMOKE_API_URL"
        return
    fi
    if [[ "${VM0_API_URL:-}" == *"-www."* ]]; then
        printf '%s' "${VM0_API_URL/-www./-api.}"
        return
    fi
    printf '%s' "${VM0_API_URL:-}"
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
#
# Tracks wall-clock via $SECONDS so a slow curl against a cold Vercel
# lambda doesn't silently eat the polling budget. Always prints the last
# state on timeout — critical for diagnosing dispatch failures where no
# run row was ever inserted.
wait_for_slack_run() {
    local team_id="$1"
    local timeout="${2:-$SLACK_POLL_TIMEOUT_S}"
    local start=$SECONDS
    local state count
    while (( SECONDS - start < timeout )); do
        state=$(slack_fetch_state "$team_id")
        # Only count rows where zero_runs.trigger_source has landed — the
        # state endpoint LEFT JOINs, so a run in flight (agent_runs insert
        # committed, zero_runs insert still pending in createZeroRunRecord)
        # would otherwise match with null triggerSource and race the
        # subsequent assertions on recent_runs[0].
        count=$(printf '%s' "$state" \
            | jq -r '[.recent_runs[] | select(.triggerSource == "slack")] | length' \
            2>/dev/null)
        if [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]]; then
            return 0
        fi
        sleep "$SLACK_POLL_INTERVAL_S"
    done
    echo "# wait_for_slack_run: timed out after $((SECONDS - start))s for team $team_id" >&2
    echo "# last state: $(slack_fetch_state "$team_id")" >&2
    return 1
}

# Run the mention/DM handler synchronously against the dispatch-probe
# endpoint and print the response. Use this as a diagnostic: if the real
# events route succeeds but wait_for_slack_run never sees a run, this
# endpoint surfaces the error that was swallowed by after().catch().
# Usage: slack_dispatch_probe <team_id> <channel_id> <user_id> <text> <ts> [channel_type]
slack_dispatch_probe() {
    local team_id="$1" channel_id="$2" user_id="$3" text="$4" ts="$5"
    local channel_type="${6:-channel}"
    local body
    body=$(jq -nc \
        --arg team_id "$team_id" \
        --arg channel_id "$channel_id" \
        --arg user_id "$user_id" \
        --arg message_text "$text" \
        --arg message_ts "$ts" \
        --arg channel_type "$channel_type" \
        '{team_id: $team_id, channel_id: $channel_id, user_id: $user_id,
          message_text: $message_text, message_ts: $message_ts,
          channel_type: $channel_type}')
    local -a bypass=()
    _slack_test_endpoint_bypass_args bypass
    local endpoint_base
    endpoint_base="$(_slack_api_backend_url)"
    endpoint_base="${endpoint_base%/}"
    # The dispatch probe is API-authoritative. Hit the API preview alias
    # directly so the diagnostic keeps exercising the handler without relying
    # on external Next rewrites to preserve preview guard headers.
    # --max-time bounds the probe so a hung handler doesn't eat the
    # entire BATS budget. 60s is generous for a cold-started lambda
    # doing DB + Clerk + mock calls.
    curl -sS --max-time 60 -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data "$body" \
        "$endpoint_base/api/test/slack-dispatch-probe"
}

# Poll test-state until a run reaches a terminal status or a timeout.
# A run is considered terminal when its status is one of: completed,
# succeeded, failed. Returns 0 on first matching run, 1 on timeout.
# Usage: wait_for_slack_run_completion <team_id> [timeout_seconds]
wait_for_slack_run_completion() {
    local team_id="$1"
    local timeout="${2:-180}"
    local start=$SECONDS
    local state status_value
    while (( SECONDS - start < timeout )); do
        state=$(slack_fetch_state "$team_id")
        # Filter to slack-triggered runs so parallel tests hitting the
        # same preview (runs with triggerSource=null from t05/t17 etc.)
        # don't get picked up as the run we're waiting on.
        status_value=$(printf '%s' "$state" \
            | jq -r '[.recent_runs[] | select(.triggerSource == "slack")][0].status // ""' \
            2>/dev/null)
        case "$status_value" in
            completed|succeeded|failed)
                echo "# run reached terminal status: $status_value after $((SECONDS - start))s" >&2
                return 0
                ;;
        esac
        sleep "${SLACK_POLL_INTERVAL_S:-3}"
    done
    echo "# wait_for_slack_run_completion: timed out after $((SECONDS - start))s for team $team_id" >&2
    echo "# last state: $(slack_fetch_state "$team_id")" >&2
    return 1
}

# Poll mock-call log until a chat.postMessage entry targeting the given
# channel is present. Returns 0 on first match.
# Usage: wait_for_slack_mock_post_message <team_id> <channel_id> [timeout_seconds]
wait_for_slack_mock_post_message() {
    local team_id="$1" channel="$2"
    local timeout="${3:-60}"
    local start=$SECONDS
    local state match
    while (( SECONDS - start < timeout )); do
        state=$(slack_fetch_state "$team_id")
        match=$(printf '%s' "$state" \
            | jq -c --arg ch "$channel" '
                [.mock_calls[]
                 | select(.method == "chat.postMessage")
                 | select(.channelId == $ch or (.bodyJson.channel // "") == $ch)]
                | .[0]' 2>/dev/null)
        if [[ -n "$match" && "$match" != "null" ]]; then
            echo "$match"
            return 0
        fi
        sleep "${SLACK_POLL_INTERVAL_S:-2}"
    done
    echo "# wait_for_slack_mock_post_message: timed out after $((SECONDS - start))s" >&2
    echo "# last state mock_calls: $(printf '%s' "$state" | jq -c '.mock_calls')" >&2
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
