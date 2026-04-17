#!/usr/bin/env bats

# End-to-end Slack integration tests against a deployed Vercel preview.
#
# Required env:
#   VM0_API_URL                        — preview deployment URL
#   SLACK_SIGNING_SECRET               — shared with the preview so HMAC matches
#   VERCEL_AUTOMATION_BYPASS_SECRET    — preview protection bypass
#
# These tests assume the preview deployment has E2E_SLACK_MOCK_ENABLED=1
# so the WebClient's outbound calls are routed to /api/test/slack-mock/*
# on the same deployment, avoiding any real traffic to slack.com.

load '../../helpers/setup'
load '../../helpers/slack'

# Unique identifiers per run to avoid collisions between parallel previews.
# Base identifiers come from helpers/slack-fixtures.sh (sourced via helpers/slack).
TEAM_ID="${SLACK_FIXTURE_TEAM_ID:-T_E2E}_${GITHUB_RUN_ID:-local}_$$"
CHANNEL_ID="${SLACK_FIXTURE_CHANNEL_ID:-C_E2E_MOCK}_${GITHUB_RUN_ID:-local}"
SLACK_USER_ID="${SLACK_FIXTURE_USER_USER_ID:-U_E2E_USER}"

setup_file() {
    if [[ -z "${VM0_API_URL:-}" ]]; then
        skip "VM0_API_URL not set"
    fi
    if [[ -z "${SLACK_SIGNING_SECRET:-}" ]]; then
        skip "SLACK_SIGNING_SECRET not set"
    fi
    export TEAM_ID CHANNEL_ID SLACK_USER_ID
    slack_reset_state "$TEAM_ID"
}

teardown_file() {
    slack_reset_state "$TEAM_ID" 2>/dev/null || true
}

@test "slack: /vm0 connect returns login message when no connection exists" {
    # Seed installation only (no connection) so connect returns the login link.
    slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" >/dev/null

    run slack_post_command "/vm0" "connect" "$TEAM_ID" "$SLACK_USER_ID" "$CHANNEL_ID"
    assert_success
    assert_output --partial '"response_type":"ephemeral"'
    # Login message contains an authorize URL.
    assert_output --partial "authorize"
}

@test "slack: app_mention dispatches an agent run" {
    slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" --with-connection >/dev/null

    local ts payload
    ts="$(date +%s).000100"
    payload=$(slack_render_fixture \
        "$TEST_ROOT/fixtures/slack/app-mention-payload.json" \
        "$TEAM_ID" "$CHANNEL_ID" "$SLACK_USER_ID" "$ts")

    run slack_post_event "$payload"
    assert_success

    wait_for_slack_run "$TEAM_ID" 30
    local state
    state=$(slack_fetch_state "$TEAM_ID")
    [[ "$(echo "$state" | jq -r '.recent_runs | length')" -gt 0 ]]
    [[ "$(echo "$state" | jq -r '.recent_runs[0].triggerSource')" == "slack" ]]
}

@test "slack: DM dispatches an agent run" {
    slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" --with-connection >/dev/null

    local ts payload
    ts="$(date +%s).000200"
    payload=$(slack_render_fixture \
        "$TEST_ROOT/fixtures/slack/dm-message-payload.json" \
        "$TEAM_ID" "D_E2E_DM" "$SLACK_USER_ID" "$ts")

    run slack_post_event "$payload"
    assert_success

    wait_for_slack_run "$TEAM_ID" 30
    local state
    state=$(slack_fetch_state "$TEAM_ID")
    [[ "$(echo "$state" | jq -r '.recent_runs | length')" -gt 0 ]]
}

@test "slack: /vm0 disconnect clears the connection" {
    slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" --with-connection >/dev/null
    # Sanity: connection exists before disconnect.
    [[ "$(slack_fetch_state "$TEAM_ID" | jq -r '.connections | length')" -ge 1 ]]

    run slack_post_command "/vm0" "disconnect" "$TEAM_ID" "$SLACK_USER_ID" "$CHANNEL_ID"
    assert_success
    assert_output --partial "disconnected"

    [[ "$(slack_fetch_state "$TEAM_ID" | jq -r '.connections | length')" -eq 0 ]]
}
