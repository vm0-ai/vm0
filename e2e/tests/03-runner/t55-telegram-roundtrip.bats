#!/usr/bin/env bats

# Full round-trip Telegram e2e: seeded bot/user link -> DM webhook -> agent
# run completes -> callback posts the reply to the Telegram Bot API mock.
#
# Required env:
#   VM0_API_URL                      — preview deployment URL
#   VERCEL_AUTOMATION_BYPASS_SECRET  — preview protection bypass
#   E2E_RUNNER_EMAIL                 — runner test user provisioned by CI
#
# The preview deployment must have E2E_TELEGRAM_MOCK_ENABLED=1 so outbound
# Bot API calls are routed to /api/test/telegram-mock/* on the same preview.

load '../../helpers/setup'
load '../../helpers/telegram'

TELEGRAM_ROUNDTRIP_PROMPT="echo HELLO_FROM_TG_E2E_$((RANDOM))"
EXPECTED_OUTPUT_PREFIX="HELLO_FROM_TG_E2E_"

BOT_ID="${TELEGRAM_FIXTURE_BOT_ID}_${GITHUB_RUN_ID:-local}"
TELEGRAM_USER_ID="$TELEGRAM_FIXTURE_USER_ID"
DM_CHAT_ID="${TELEGRAM_FIXTURE_CHAT_ID}${GITHUB_RUN_ID:-0}"

export BATS_TEST_TIMEOUT=180

setup_file() {
    if [[ -z "${VM0_API_URL:-}" ]]; then
        skip "VM0_API_URL not set"
    fi
    export E2E_SERIAL_EMAIL="${E2E_RUNNER_EMAIL:-${E2E_SERIAL_EMAIL:-}}"
    export BOT_ID TELEGRAM_USER_ID DM_CHAT_ID TELEGRAM_ROUNDTRIP_PROMPT

    telegram_reset_state "$BOT_ID"

    local preflight
    preflight=$(telegram_seed_state "$BOT_ID" "$TELEGRAM_USER_ID")
    if [[ "$(echo "$preflight" | jq -r '.ok // false')" != "true" ]]; then
        echo "# telegram_seed_state pre-flight failed" >&2
        echo "# response: $preflight" >&2
        echo "# E2E_SERIAL_EMAIL=${E2E_SERIAL_EMAIL:-<unset>}" >&2
        return 1
    fi

    local -a bypass=()
    _telegram_bypass_args bypass
    local code
    code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data '{}' \
        "$VM0_API_URL/api/test/telegram-mock/bot$TELEGRAM_FIXTURE_BOT_TOKEN/getMe")
    if [[ "$code" != "200" ]]; then
        echo "# mock endpoint /api/test/telegram-mock/.../getMe returned HTTP $code" >&2
        return 1
    fi
}

teardown_file() {
    telegram_reset_state "$BOT_ID" 2>/dev/null || true
}

@test "telegram: DM message round-trip — run completes and reply posts to chat" {
    telegram_reset_state "$BOT_ID"
    telegram_seed_state "$BOT_ID" "$TELEGRAM_USER_ID" >/dev/null

    local payload
    payload=$(telegram_render_fixture \
        "$TEST_ROOT/fixtures/telegram/dm-message-payload.json" \
        "$BOT_ID" "$DM_CHAT_ID" "$TELEGRAM_USER_ID" "1001" \
        | jq --arg p "$TELEGRAM_ROUNDTRIP_PROMPT" '.message.text = $p')

    run telegram_post_webhook "$BOT_ID" "$payload"
    assert_success
    assert_output --partial "OK"

    wait_for_telegram_run_completion "$BOT_ID" 150

    local state status_value
    state=$(telegram_fetch_state "$BOT_ID")
    status_value=$(echo "$state" | jq -r '[.recent_runs[] | select(.triggerSource == "telegram")][0].status // ""')
    [[ "$status_value" == "completed" || "$status_value" == "succeeded" ]] || {
        echo "# run ended in non-successful state: $status_value" >&2
        echo "# state: $state" >&2
        return 1
    }

    local call posted_text
    call=$(wait_for_telegram_mock_send_message \
        "$BOT_ID" "$DM_CHAT_ID" "$EXPECTED_OUTPUT_PREFIX" 60)
    posted_text=$(echo "$call" | jq -r '.bodyJson.text // ""')
    echo "# posted text: $posted_text" >&2
    [[ "$posted_text" == *"$EXPECTED_OUTPUT_PREFIX"* ]] || {
        echo "# expected posted text to contain '$EXPECTED_OUTPUT_PREFIX'" >&2
        echo "# full state: $state" >&2
        return 1
    }
}
