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

# Per-test timeout needs to cover: seed (~1s) + post event (~1s) +
# wait_for_slack_run polling loop (SLACK_POLL_TIMEOUT_S) + final state
# fetch on failure (~1s). The default 30s budget set by the workflow
# runner is too tight once cold-start latency eats into polling.
# Set at file-scope so BATS applies it before each @test forks.
export BATS_TEST_TIMEOUT=90

# Unique identifiers per run to avoid collisions between parallel previews.
# Base identifiers come from helpers/slack-fixtures.sh (sourced via helpers/slack).
# IMPORTANT: don't include $$ here — BATS runs each @test in a new subshell,
# so $$ varies between setup_file and each test, making TEAM_ID inconsistent
# and causing the slash-command handler to miss the seeded installation.
# GITHUB_RUN_ID is stable across the whole job, which is the isolation scope
# we actually want against a shared preview DB.
TEAM_ID="${SLACK_FIXTURE_TEAM_ID:-T_E2E}_${GITHUB_RUN_ID:-local}"
CHANNEL_ID="${SLACK_FIXTURE_CHANNEL_ID:-C_E2E_MOCK}_${GITHUB_RUN_ID:-local}"
SLACK_USER_ID="${SLACK_FIXTURE_USER_USER_ID:-U_E2E_USER}"

setup_file() {
    if [[ -z "${VM0_API_URL:-}" ]]; then
        skip "VM0_API_URL not set"
    fi
    if [[ -z "${SLACK_SIGNING_SECRET:-}" ]]; then
        skip "SLACK_SIGNING_SECRET not set"
    fi
    # Per-test timeout needs to cover: seed (~1s) + post event (~1s) +
    # wait_for_slack_run polling loop (SLACK_POLL_TIMEOUT_S) + final
    # state fetch on failure (~1s). The default 30s budget set by the
    # workflow runner is too tight once cold-start latency eats into
    # the polling budget.
    export BATS_TEST_TIMEOUT=90
    export TEAM_ID CHANNEL_ID SLACK_USER_ID
    slack_reset_state "$TEAM_ID"

    # Pre-flight: seed installation + connection once so every test can
    # either reset connection or mutate installation without races. Also
    # fails loudly here with the raw response body if the seed endpoint
    # is misconfigured, rather than masking as per-test assertion noise.
    local preflight
    preflight=$(slack_seed_state "$TEAM_ID" "$SLACK_USER_ID")
    if [[ "$(echo "$preflight" | jq -r '.ok // false')" != "true" ]]; then
        echo "# slack_seed_state pre-flight failed" >&2
        echo "# response: $preflight" >&2
        echo "# E2E_SERIAL_EMAIL=${E2E_SERIAL_EMAIL:-<unset>}" >&2
        return 1
    fi
    export E2E_SEED_VM0_USER_ID
    E2E_SEED_VM0_USER_ID=$(echo "$preflight" | jq -r '.vm0_user_id')

    # Probe every mock Slack endpoint to catch routing regressions early —
    # Next.js has historically been finicky about dotted folder names, and
    # a silent 404 here would masquerade as a dispatch failure much later.
    local -a bypass=()
    _slack_bypass_args bypass
    local mock
    for mock in chat.postMessage chat.postEphemeral conversations.open \
                conversations.history conversations.replies views.publish \
                assistant.threads.setStatus users.info auth.test \
                oauth.v2.access; do
        local code
        code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            "${bypass[@]}" \
            --data '{}' \
            "$VM0_API_URL/api/test/slack-mock/$mock")
        if [[ "$code" != "200" ]]; then
            echo "# mock endpoint /api/test/slack-mock/$mock returned HTTP $code" >&2
            return 1
        fi
    done
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
    # buildLoginMessage renders a Connect button linking to /settings/slack.
    assert_output --partial "Please connect your account"
    assert_output --partial "/settings/slack"
}

@test "slack: app_mention handler runs without error (dispatch probe)" {
    slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" --with-connection --with-default-agent >/dev/null

    local ts probe_resp
    ts="$(date +%s).000090"
    probe_resp=$(slack_dispatch_probe "$TEAM_ID" "$CHANNEL_ID" "$SLACK_USER_ID" \
        "hello from e2e mention probe" "$ts" "channel")
    # The probe either returns {ok: true} (dispatch ran, run row created)
    # or {ok: false, error: {...}}. Anything else is a transport bug.
    local ok
    ok=$(echo "$probe_resp" | jq -r '.ok')
    if [[ "$ok" != "true" ]]; then
        echo "# dispatch-probe returned failure:" >&2
        echo "$probe_resp" | jq '.' >&2
        return 1
    fi
}

@test "slack: app_mention dispatches an agent run" {
    # Reset first so the dispatch-probe's run from the previous test doesn't
    # mask a partial-insert race on this test's own async dispatch (where
    # agent_runs lands before zero_runs and recent_runs[0] has a null
    # triggerSource via the LEFT JOIN).
    slack_reset_state "$TEAM_ID"
    local seed_resp vm0_user_id
    seed_resp=$(slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" --with-connection --with-default-agent)
    vm0_user_id=$(echo "$seed_resp" | jq -r '.vm0_user_id')
    [[ -n "$vm0_user_id" && "$vm0_user_id" != "null" ]]

    local ts payload
    ts="$(date +%s).000100"
    payload=$(slack_render_fixture \
        "$TEST_ROOT/fixtures/slack/app-mention-payload.json" \
        "$TEAM_ID" "$CHANNEL_ID" "$SLACK_USER_ID" "$ts")

    run slack_post_event "$payload"
    assert_success

    if ! wait_for_slack_run "$TEAM_ID"; then
        return 1
    fi
    local state first_run
    state=$(slack_fetch_state "$TEAM_ID")
    [[ "$(echo "$state" | jq -r '.recent_runs | length')" -gt 0 ]]
    first_run=$(echo "$state" | jq -c '.recent_runs[0]')
    [[ "$(echo "$first_run" | jq -r '.triggerSource')" == "slack" ]]
    # Run must be attributed to the vm0 user the connection belongs to.
    [[ "$(echo "$first_run" | jq -r '.userId')" == "$vm0_user_id" ]]
    # Prompt preview must reflect the app_mention text so a dispatch bug
    # that sends the wrong payload is caught.
    [[ "$(echo "$first_run" | jq -r '.promptPreview')" == *"hello from e2e"* ]]
    # Status is a known enum value — reject empty/null from a broken insert.
    [[ "$(echo "$first_run" | jq -r '.status')" != "null" ]]
    [[ -n "$(echo "$first_run" | jq -r '.status')" ]]
}

@test "slack: DM dispatches an agent run" {
    # Reset so the previous mention's run doesn't become recent_runs[0]
    # and mask a genuine DM dispatch failure.
    slack_reset_state "$TEAM_ID"
    local seed_resp vm0_user_id
    seed_resp=$(slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" --with-connection --with-default-agent)
    vm0_user_id=$(echo "$seed_resp" | jq -r '.vm0_user_id')
    [[ -n "$vm0_user_id" && "$vm0_user_id" != "null" ]]

    local ts payload
    ts="$(date +%s).000200"
    payload=$(slack_render_fixture \
        "$TEST_ROOT/fixtures/slack/dm-message-payload.json" \
        "$TEAM_ID" "D_E2E_DM" "$SLACK_USER_ID" "$ts")

    run slack_post_event "$payload"
    assert_success

    if ! wait_for_slack_run "$TEAM_ID"; then
        return 1
    fi
    local state first_run
    state=$(slack_fetch_state "$TEAM_ID")
    [[ "$(echo "$state" | jq -r '.recent_runs | length')" -gt 0 ]]
    first_run=$(echo "$state" | jq -c '.recent_runs[0]')
    [[ "$(echo "$first_run" | jq -r '.triggerSource')" == "slack" ]]
    [[ "$(echo "$first_run" | jq -r '.userId')" == "$vm0_user_id" ]]
    [[ "$(echo "$first_run" | jq -r '.promptPreview')" == *"hello from e2e DM"* ]]
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
