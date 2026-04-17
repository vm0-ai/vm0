#!/usr/bin/env bash

# Slack e2e helpers: HMAC-sign webhook payloads and interact with the
# test-state endpoint hosted on the same Vercel preview deployment.
#
# Required env:
#   VM0_API_URL                        — target web app URL
#   SLACK_SIGNING_SECRET               — shared secret the preview is deployed with
#   VERCEL_AUTOMATION_BYPASS_SECRET    — for test-state endpoint on preview

# Build curl args with bypass header when available.
_slack_curl_headers() {
    local -a headers=(-H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    printf '%s\n' "${headers[@]}"
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
    local channel_id="${5:-C_E2E}"
    local body
    body=$(
        printf 'token=xoxb-test&team_id=%s&team_domain=e2e&channel_id=%s&channel_name=e2e&user_id=%s&user_name=e2e-user&command=%s&text=%s&api_app_id=A_E2E_APP' \
            "$team_id" "$channel_id" "$user_id" "$command" "$text"
    )
    slack_sign_body "$body"
    local -a bypass=()
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        bypass=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
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
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        bypass=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
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
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        bypass=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl -sS "${bypass[@]}" \
        "$VM0_API_URL/api/test/slack-state?team_id=$team_id"
}

# Seed a Slack installation (and optionally a connection) for the test user.
# Usage: slack_seed_state <team_id> <slack_user_id> [--with-connection]
slack_seed_state() {
    local team_id="$1" slack_user_id="$2"
    local seed_connection="false"
    if [[ "${3:-}" == "--with-connection" ]]; then
        seed_connection="true"
    fi
    local body
    body=$(jq -nc \
        --arg team_id "$team_id" \
        --arg slack_user_id "$slack_user_id" \
        --argjson seed_connection "$seed_connection" \
        '{team_id: $team_id, slack_user_id: $slack_user_id, seed_connection: $seed_connection}')
    local -a bypass=()
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        bypass=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
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
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        bypass=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl -sS -X DELETE "${bypass[@]}" \
        "$VM0_API_URL/api/test/slack-state?team_id=$team_id" >/dev/null
}

# Poll test-state until `recent_runs` contains at least one entry or timeout.
# Usage: wait_for_slack_run <team_id> <timeout_seconds>
wait_for_slack_run() {
    local team_id="$1"
    local timeout="${2:-30}"
    local elapsed=0
    while (( elapsed < timeout )); do
        local state
        state=$(slack_fetch_state "$team_id")
        local count
        count=$(printf '%s' "$state" | jq -r '.recent_runs | length')
        if [[ "$count" -gt 0 ]]; then
            return 0
        fi
        sleep 2
        (( elapsed += 2 ))
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
