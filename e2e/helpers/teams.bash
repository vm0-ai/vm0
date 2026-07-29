#!/usr/bin/env bash

# Teams e2e helpers: seed preview state, dispatch synthetic Teams messages,
# and poll test-state for run and mock Bot Framework side effects.

# shellcheck source=./teams-fixtures.sh
source "$(dirname "${BASH_SOURCE[0]}")/teams-fixtures.sh"

TEAMS_POLL_INTERVAL_S="${TEAMS_POLL_INTERVAL_S:-2}"
TEAMS_POLL_TIMEOUT_S="${TEAMS_POLL_TIMEOUT_S:-60}"

_teams_bypass_args() {
    local -n _out="$1"
    _out=()
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        _out+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
}

teams_mock_service_url() {
    local base="${VM0_API_BACKEND_URL%/}"
    printf '%s/api/test/teams-mock/service/' "$base"
}

teams_fetch_state() {
    local tenant_id="$1"
    local -a bypass=()
    _teams_bypass_args bypass
    curl -sS "${bypass[@]}" \
        "$VM0_API_BACKEND_URL/api/test/teams-state?tenant_id=$tenant_id"
}

teams_seed_state() {
    local tenant_id="$1" teams_user_id="$2"
    shift 2
    local seed_connection="true"
    local seed_default_agent="true"
    for flag in "$@"; do
        case "$flag" in
            --without-connection) seed_connection="false" ;;
            --without-default-agent) seed_default_agent="false" ;;
        esac
    done
    local email="${E2E_SERIAL_EMAIL:-}"
    local body
    body=$(jq -nc \
        --arg tenant_id "$tenant_id" \
        --arg tenant_name "$TEAMS_FIXTURE_TENANT_NAME" \
        --arg team_id "$TEAMS_FIXTURE_TEAM_ID" \
        --arg team_name "$TEAMS_FIXTURE_TEAM_NAME" \
        --arg service_url "$(teams_mock_service_url)" \
        --arg teams_user_id "$teams_user_id" \
        --arg teams_aad_object_id "$TEAMS_FIXTURE_AAD_OBJECT_ID" \
        --arg teams_user_display_name "$TEAMS_FIXTURE_USER_NAME" \
        --arg teams_user_principal_name "$TEAMS_FIXTURE_USER_PRINCIPAL_NAME" \
        --arg bot_id "$TEAMS_FIXTURE_BOT_ID" \
        --arg bot_name "$TEAMS_FIXTURE_BOT_NAME" \
        --arg email "$email" \
        --argjson seed_connection "$seed_connection" \
        --argjson seed_default_agent "$seed_default_agent" \
        '{tenant_id: $tenant_id, tenant_name: $tenant_name,
          team_id: $team_id, team_name: $team_name, service_url: $service_url,
          teams_user_id: $teams_user_id,
          teams_aad_object_id: $teams_aad_object_id,
          teams_user_display_name: $teams_user_display_name,
          teams_user_principal_name: $teams_user_principal_name,
          bot_id: $bot_id, bot_name: $bot_name,
          seed_connection: $seed_connection,
          seed_default_agent: $seed_default_agent}
         + (if $email == "" then {} else {email: $email} end)')
    local -a bypass=()
    _teams_bypass_args bypass
    curl -sS -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_BACKEND_URL/api/test/teams-state"
}

teams_reset_state() {
    local tenant_id="$1"
    local -a bypass=()
    _teams_bypass_args bypass
    curl -sS -X DELETE "${bypass[@]}" \
        "$VM0_API_BACKEND_URL/api/test/teams-state?tenant_id=$tenant_id" >/dev/null
}

teams_dispatch_probe_activity() {
    local activity="$1"
    local body
    body=$(printf '%s' "$activity" | jq -c '{
        tenant_id: .channelData.tenant.id,
        tenant_name: .channelData.tenant.name,
        team_id: (.channelData.team.id // null),
        team_name: (.channelData.team.name // null),
        channel_id: (.channelData.channel.id // null),
        conversation_id: .conversation.id,
        conversation_type: .conversation.conversationType,
        service_url: .serviceUrl,
        activity_id: .id,
        thread_id: (.replyToId // .id),
        teams_user_id: .from.id,
        teams_aad_object_id: .from.aadObjectId,
        teams_user_display_name: .from.name,
        teams_user_principal_name: .from.userPrincipalName,
        bot_id: .recipient.id,
        bot_name: .recipient.name,
        message_text: .text
    }')
    local -a bypass=()
    _teams_bypass_args bypass
    curl -sS --max-time 60 -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_BACKEND_URL/api/test/teams-dispatch-probe"
}

wait_for_teams_run_completion() {
    local tenant_id="$1"
    local timeout="${2:-180}"
    local start=$SECONDS
    local state status_value
    while (( SECONDS - start < timeout )); do
        state=$(teams_fetch_state "$tenant_id")
        status_value=$(printf '%s' "$state" \
            | jq -r '[.recent_runs[] | select(.triggerSource == "teams")][0].status // ""' \
            2>/dev/null)
        case "$status_value" in
            completed|succeeded|failed)
                echo "# teams run reached terminal status: $status_value after $((SECONDS - start))s" >&2
                return 0
                ;;
        esac
        sleep "$TEAMS_POLL_INTERVAL_S"
    done
    echo "# wait_for_teams_run_completion: timed out after $((SECONDS - start))s for tenant $tenant_id" >&2
    echo "# last state: $(teams_fetch_state "$tenant_id")" >&2
    return 1
}

wait_for_teams_mock_reply_activity() {
    local tenant_id="$1" conversation_id="$2" expected_text="$3"
    local timeout="${4:-60}"
    local start=$SECONDS
    local state match failed_callback
    while (( SECONDS - start < timeout )); do
        state=$(teams_fetch_state "$tenant_id")
        match=$(printf '%s' "$state" \
            | jq -c --arg conversation "$conversation_id" --arg expected "$expected_text" '
                [.mock_calls[]
                 | select(.method == "replyActivity")
                 | select((.conversationId // "") == $conversation)
                 | select((.bodyJson.text // "") | contains($expected))]
                | .[0]' 2>/dev/null)
        if [[ -n "$match" && "$match" != "null" ]]; then
            echo "$match"
            return 0
        fi
        failed_callback=$(printf '%s' "$state" \
            | jq -c '
                [.recent_callbacks[]?
                 | select(.internalKind == "teams:chat")
                 | select(.status == "failed")]
                | .[0]' 2>/dev/null)
        if [[ -n "$failed_callback" && "$failed_callback" != "null" ]]; then
            echo "# Teams callback failed before reply was observed" >&2
            echo "# callback: $failed_callback" >&2
            echo "# mock_calls: $(printf '%s' "$state" | jq -c '.mock_calls')" >&2
            return 1
        fi
        sleep "$TEAMS_POLL_INTERVAL_S"
    done
    echo "# wait_for_teams_mock_reply_activity: timed out after $((SECONDS - start))s" >&2
    echo "# last state callbacks: $(printf '%s' "$state" | jq -c '.recent_callbacks')" >&2
    echo "# last state mock_calls: $(printf '%s' "$state" | jq -c '.mock_calls')" >&2
    return 1
}

teams_render_fixture() {
    local path="$1" tenant_id="$2" conversation_id="$3" user_id="$4" activity_id="$5"
    sed \
        -e "s|{{SERVICE_URL}}|$(teams_mock_service_url)|g" \
        -e "s/{{TENANT_ID}}/$tenant_id/g" \
        -e "s/{{TENANT_NAME}}/$TEAMS_FIXTURE_TENANT_NAME/g" \
        -e "s/{{TEAM_ID}}/$TEAMS_FIXTURE_TEAM_ID/g" \
        -e "s/{{TEAM_NAME}}/$TEAMS_FIXTURE_TEAM_NAME/g" \
        -e "s/{{CHANNEL_ID}}/$TEAMS_FIXTURE_CHANNEL_ID/g" \
        -e "s/{{CONVERSATION_ID}}/$conversation_id/g" \
        -e "s/{{ACTIVITY_ID}}/$activity_id/g" \
        -e "s/{{BOT_ID}}/$TEAMS_FIXTURE_BOT_ID/g" \
        -e "s/{{BOT_NAME}}/$TEAMS_FIXTURE_BOT_NAME/g" \
        -e "s/{{USER_ID}}/$user_id/g" \
        -e "s/{{USER_AAD_ID}}/$TEAMS_FIXTURE_AAD_OBJECT_ID/g" \
        -e "s/{{USER_NAME}}/$TEAMS_FIXTURE_USER_NAME/g" \
        -e "s/{{USER_PRINCIPAL_NAME}}/$TEAMS_FIXTURE_USER_PRINCIPAL_NAME/g" \
        "$path"
}
