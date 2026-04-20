#!/usr/bin/env bats

# Full round-trip Slack e2e: connect → DM message → agent run completes →
# callback posts reply to Slack. Runs on cli-e2e-03-runner so a real
# runner picks up the dispatched job and drives it to completion with
# mock-claude (USE_MOCK_CLAUDE=true). Without this, a regression that
# leaves runs stuck in "pending" (e.g. a dropped dispatch Promise) would
# go unnoticed.
#
# Required env:
#   VM0_API_URL                      — preview deployment URL
#   SLACK_SIGNING_SECRET             — shared with the preview for HMAC
#   VERCEL_AUTOMATION_BYPASS_SECRET  — preview protection bypass
#   E2E_RUNNER_EMAIL                 — the test user the runner job runs as
#                                      (cli-e2e-03-runner sets this)

load '../../helpers/setup'
load '../../helpers/slack'

# The mention/DM prompt is piped to mock-claude which executes it as a
# bash command and echoes the stdout back as the agent's reply. We pick
# a side-effect-free command whose output is easy to match.
SLACK_ROUNDTRIP_PROMPT="echo HELLO_FROM_E2E_$((RANDOM))"
EXPECTED_OUTPUT_PREFIX="HELLO_FROM_E2E_"

# File-scope identifiers unique per CI run (GITHUB_RUN_ID).
TEAM_ID="T_E2E_RT_${GITHUB_RUN_ID:-local}"
SLACK_USER_ID="U_E2E_USER_RT"
DM_CHANNEL_ID="D_E2E_RT_${GITHUB_RUN_ID:-local}"

# 3-minute per-test budget: runner cold-start (~20s) + mock-claude
# execution (~5s) + callback (~2s) + polling overhead.
export BATS_TEST_TIMEOUT=180

setup_file() {
    if [[ -z "${VM0_API_URL:-}" ]]; then
        skip "VM0_API_URL not set"
    fi
    if [[ -z "${SLACK_SIGNING_SECRET:-}" ]]; then
        skip "SLACK_SIGNING_SECRET not set"
    fi
    # Use the runner test user since cli-e2e-03-runner provisions that one.
    export E2E_SERIAL_EMAIL="${E2E_RUNNER_EMAIL:-${E2E_SERIAL_EMAIL:-}}"
    export TEAM_ID SLACK_USER_ID DM_CHANNEL_ID SLACK_ROUNDTRIP_PROMPT
    slack_reset_state "$TEAM_ID"

    # Seed installation + connection + default agent up front so every
    # test can either reuse or reset.
    local preflight
    preflight=$(slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" \
        --with-connection --with-default-agent)
    if [[ "$(echo "$preflight" | jq -r '.ok // false')" != "true" ]]; then
        echo "# slack_seed_state pre-flight failed" >&2
        echo "# response: $preflight" >&2
        echo "# E2E_SERIAL_EMAIL=${E2E_SERIAL_EMAIL:-<unset>}" >&2
        return 1
    fi
}

teardown_file() {
    slack_reset_state "$TEAM_ID" 2>/dev/null || true
}

@test "slack: DM message round-trip — run completes and reply posts to channel" {
    # Reset so the run we're about to create is recent_runs[0].
    slack_reset_state "$TEAM_ID"
    slack_seed_state "$TEAM_ID" "$SLACK_USER_ID" \
        --with-connection --with-default-agent >/dev/null

    # Build a DM event. The message text becomes the agent's prompt,
    # and mock-claude will execute it as bash → output echoed back as
    # the agent's result → Slack callback posts it to our mock.
    local ts payload
    ts="$(date +%s).000100"
    # Render the DM fixture then substitute our bash-executable prompt
    # for the template's placeholder text.
    payload=$(slack_render_fixture \
        "$TEST_ROOT/fixtures/slack/dm-message-payload.json" \
        "$TEAM_ID" "$DM_CHANNEL_ID" "$SLACK_USER_ID" "$ts" \
        | jq --arg p "$SLACK_ROUNDTRIP_PROMPT" '.event.text = $p')

    run slack_post_event "$payload"
    assert_success

    # Wait for the run to reach a terminal state — this is the main
    # regression guard. If dispatch drops the Promise and the runner
    # never picks up the job, the run stays at "pending" forever and
    # this times out.
    wait_for_slack_run_completion "$TEAM_ID" 150

    # The terminal status must be successful — a failed run indicates
    # the runner picked up the job but mock-claude's bash exited non-zero.
    # Filter to slack-triggered runs because parallel tests in the same
    # shard (t05/t17) create non-slack runs that would otherwise be
    # recent_runs[0].
    local state status_value
    state=$(slack_fetch_state "$TEAM_ID")
    status_value=$(echo "$state" | jq -r '[.recent_runs[] | select(.triggerSource == "slack")][0].status // ""')
    [[ "$status_value" == "completed" || "$status_value" == "succeeded" ]] || {
        echo "# run ended in non-successful state: $status_value" >&2
        echo "# state: $state" >&2
        return 1
    }

    # The callback must have posted the agent's reply back to the DM
    # channel via our mocked chat.postMessage. This is the other half of
    # the round-trip — without it, the user would never see the bot's
    # response even though the run "succeeded".
    local call
    call=$(wait_for_slack_mock_post_message "$TEAM_ID" "$DM_CHANNEL_ID" 60)

    # The posted text must contain mock-claude's bash-echoed output so
    # we know the reply actually carries the agent's result, not a canned
    # error string or a thinking-status update.
    local posted_text
    posted_text=$(echo "$call" | jq -r '.bodyJson.text // ""')
    echo "# posted text: $posted_text" >&2
    [[ "$posted_text" == *"$EXPECTED_OUTPUT_PREFIX"* ]] || {
        echo "# expected posted text to contain '$EXPECTED_OUTPUT_PREFIX'" >&2
        echo "# full state: $state" >&2
        return 1
    }
}
