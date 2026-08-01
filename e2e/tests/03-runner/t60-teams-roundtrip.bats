#!/usr/bin/env bats

# Full round-trip Teams e2e: seeded tenant/user connection -> DM dispatch ->
# real agent run completes -> callback posts the reply to the Teams mock.
#
# Required env:
#   VM0_API_BACKEND_URL
#   VERCEL_AUTOMATION_BYPASS_SECRET
#   E2E_RUNNER_EMAIL
#
# The preview deployment must have E2E_TEAMS_MOCK_ENABLED=1 so outbound
# Bot Framework token and send calls are routed to /api/test/teams-mock/*.

load '../../helpers/setup'
load '../../helpers/teams'

TEAMS_ROUNDTRIP_PROMPT="Reply with exactly: HELLO_FROM_TEAMS_E2E_$((RANDOM))"
EXPECTED_OUTPUT_PREFIX="HELLO_FROM_TEAMS_E2E_"

TENANT_ID="${TEAMS_FIXTURE_TENANT_ID}_${GITHUB_RUN_ID:-local}"
TEAMS_USER_ID="${TEAMS_FIXTURE_USER_ID}_${GITHUB_RUN_ID:-local}"
CONVERSATION_ID="19:teams-dm-${GITHUB_RUN_ID:-local}@thread.v2"
ACTIVITY_ID="activity-teams-${GITHUB_RUN_ID:-local}"

setup_file() {
    if [[ -z "${VM0_API_BACKEND_URL:-}" ]]; then
        skip "VM0_API_BACKEND_URL not set"
    fi
    export E2E_SERIAL_EMAIL="${E2E_RUNNER_EMAIL:-${E2E_SERIAL_EMAIL:-}}"
    export TENANT_ID TEAMS_USER_ID CONVERSATION_ID ACTIVITY_ID TEAMS_ROUNDTRIP_PROMPT

    teams_reset_state "$TENANT_ID"

    local preflight
    preflight=$(teams_seed_state "$TENANT_ID" "$TEAMS_USER_ID")
    if [[ "$(echo "$preflight" | jq -r '.ok // false')" != "true" ]]; then
        echo "# teams_seed_state pre-flight failed" >&2
        echo "# response: $preflight" >&2
        echo "# E2E_SERIAL_EMAIL=${E2E_SERIAL_EMAIL:-<unset>}" >&2
        return 1
    fi

    local -a bypass=()
    _teams_bypass_args bypass
    local code
    code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/x-www-form-urlencoded" \
        "${bypass[@]}" \
        --data 'grant_type=client_credentials' \
        "$VM0_API_BACKEND_URL/api/test/teams-mock/token")
    if [[ "$code" != "200" ]]; then
        echo "# mock endpoint /api/test/teams-mock/token returned HTTP $code" >&2
        return 1
    fi
}

teardown_file() {
    teams_reset_state "$TENANT_ID" 2>/dev/null || true
}

@test "teams: DM message round-trip - run completes and reply posts to conversation" {
    teams_reset_state "$TENANT_ID"
    teams_seed_state "$TENANT_ID" "$TEAMS_USER_ID" >/dev/null

    local payload
    payload=$(teams_render_fixture \
        "$TEST_ROOT/fixtures/teams/dm-message-activity.json" \
        "$TENANT_ID" "$CONVERSATION_ID" "$TEAMS_USER_ID" "$ACTIVITY_ID" \
        | jq --arg p "$TEAMS_ROUNDTRIP_PROMPT" '.text = $p')

    run teams_dispatch_probe_activity "$payload"
    assert_success
    assert_output --partial '"ok":true'

    wait_for_teams_run_completion "$TENANT_ID" 150

    local state status_value chat_thread_id route_count
    state=$(teams_fetch_state "$TENANT_ID")
    status_value=$(echo "$state" | jq -r '[.recent_runs[] | select(.triggerSource == "teams")][0].status // ""')
    [[ "$status_value" == "completed" || "$status_value" == "succeeded" ]] || {
        echo "# run ended in non-successful state: $status_value" >&2
        echo "# state: $state" >&2
        return 1
    }
    chat_thread_id=$(echo "$state" | jq -r '[.recent_runs[] | select(.triggerSource == "teams")][0].chatThreadId // ""')
    [[ -n "$chat_thread_id" ]] || {
        echo "# Teams run was not bound to a canonical chat thread" >&2
        echo "# state: $state" >&2
        return 1
    }
    route_count=$(echo "$state" | jq \
        --arg conversation "$CONVERSATION_ID" \
        --arg chat_thread_id "$chat_thread_id" \
        '[.routes[]
          | select(.conversationId == $conversation)
          | select(.chatThreadId == $chat_thread_id)]
         | length')
    [[ "$route_count" == "1" ]] || {
        echo "# canonical Teams chat-thread route was not created" >&2
        echo "# state: $state" >&2
        return 1
    }

    local call posted_text
    call=$(wait_for_teams_mock_reply_activity \
        "$TENANT_ID" "$CONVERSATION_ID" "$EXPECTED_OUTPUT_PREFIX" 60)
    posted_text=$(echo "$call" | jq -r '.bodyJson.text // ""')
    echo "# posted text: $posted_text" >&2
    [[ "$posted_text" == *"$EXPECTED_OUTPUT_PREFIX"* ]] || {
        echo "# expected posted text to contain '$EXPECTED_OUTPUT_PREFIX'" >&2
        echo "# full state: $state" >&2
        return 1
    }
}
