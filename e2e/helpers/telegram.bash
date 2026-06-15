#!/usr/bin/env bash

# Telegram e2e helpers: seed preview state, post webhook payloads, and poll
# test-state for run and mock Bot API side effects.

# shellcheck source=./telegram-fixtures.sh
source "$(dirname "${BASH_SOURCE[0]}")/telegram-fixtures.sh"

TELEGRAM_POLL_INTERVAL_S="${TELEGRAM_POLL_INTERVAL_S:-2}"
TELEGRAM_POLL_TIMEOUT_S="${TELEGRAM_POLL_TIMEOUT_S:-60}"

_telegram_bypass_args() {
    local -n _out="$1"
    _out=()
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        _out+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
}

telegram_fetch_state() {
    local bot_id="$1"
    local -a bypass=()
    _telegram_bypass_args bypass
    curl -sS "${bypass[@]}" \
        "$VM0_API_URL/api/test/telegram-state?bot_id=$bot_id"
}

telegram_seed_state() {
    local bot_id="$1" telegram_user_id="$2"
    shift 2
    local seed_link="true"
    for flag in "$@"; do
        case "$flag" in
            --without-link) seed_link="false" ;;
        esac
    done
    local email="${E2E_SERIAL_EMAIL:-}"
    local body
    body=$(jq -nc \
        --arg bot_id "$bot_id" \
        --arg bot_username "$TELEGRAM_FIXTURE_BOT_USERNAME" \
        --arg webhook_secret "$TELEGRAM_FIXTURE_WEBHOOK_SECRET" \
        --arg telegram_user_id "$telegram_user_id" \
        --arg email "$email" \
        --argjson seed_link "$seed_link" \
        '{bot_id: $bot_id, bot_username: $bot_username,
          webhook_secret: $webhook_secret, telegram_user_id: $telegram_user_id,
          seed_link: $seed_link}
         + (if $email == "" then {} else {email: $email} end)')
    local -a bypass=()
    _telegram_bypass_args bypass
    curl -sS -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_URL/api/test/telegram-state"
}

telegram_reset_state() {
    local bot_id="$1"
    local -a bypass=()
    _telegram_bypass_args bypass
    curl -sS -X DELETE "${bypass[@]}" \
        "$VM0_API_URL/api/test/telegram-state?bot_id=$bot_id" >/dev/null
}

telegram_post_webhook() {
    local bot_id="$1" body="$2"
    local -a bypass=()
    _telegram_bypass_args bypass
    curl -sS -X POST \
        -H "Content-Type: application/json" \
        -H "x-telegram-bot-api-secret-token: $TELEGRAM_FIXTURE_WEBHOOK_SECRET" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_URL/api/telegram/webhook/$bot_id"
}

telegram_dispatch_probe() {
    local bot_id="$1" chat_id="$2" telegram_user_id="$3" text="$4"
    local body
    body=$(jq -nc \
        --arg bot_id "$bot_id" \
        --arg chat_id "$chat_id" \
        --arg telegram_user_id "$telegram_user_id" \
        --arg message_text "$text" \
        '{bot_id: $bot_id, chat_id: $chat_id,
          telegram_user_id: $telegram_user_id, message_text: $message_text}')
    local -a bypass=()
    _telegram_bypass_args bypass
    curl -sS --max-time 60 -X POST \
        -H "Content-Type: application/json" \
        "${bypass[@]}" \
        --data "$body" \
        "$VM0_API_URL/api/test/telegram-dispatch-probe"
}

wait_for_telegram_run_completion() {
    local bot_id="$1"
    local timeout="${2:-180}"
    local start=$SECONDS
    local state status_value
    while (( SECONDS - start < timeout )); do
        state=$(telegram_fetch_state "$bot_id")
        status_value=$(printf '%s' "$state" \
            | jq -r '[.recent_runs[] | select(.triggerSource == "telegram")][0].status // ""' \
            2>/dev/null)
        case "$status_value" in
            completed|succeeded|failed)
                echo "# telegram run reached terminal status: $status_value after $((SECONDS - start))s" >&2
                return 0
                ;;
        esac
        sleep "$TELEGRAM_POLL_INTERVAL_S"
    done
    echo "# wait_for_telegram_run_completion: timed out after $((SECONDS - start))s for bot $bot_id" >&2
    echo "# last state: $(telegram_fetch_state "$bot_id")" >&2
    return 1
}

wait_for_telegram_mock_send_message() {
    local bot_id="$1" chat_id="$2" expected_text="$3"
    local timeout="${4:-60}"
    local start=$SECONDS
    local state match
    while (( SECONDS - start < timeout )); do
        state=$(telegram_fetch_state "$bot_id")
        match=$(printf '%s' "$state" \
            | jq -c --arg ch "$chat_id" --arg expected "$expected_text" '
                [.mock_calls[]
                 | select(.method == "sendMessage")
                 | select((.chatId // "") == $ch)
                 | select((.bodyJson.text // "") | contains($expected))]
                | .[0]' 2>/dev/null)
        if [[ -n "$match" && "$match" != "null" ]]; then
            echo "$match"
            return 0
        fi
        sleep "$TELEGRAM_POLL_INTERVAL_S"
    done
    echo "# wait_for_telegram_mock_send_message: timed out after $((SECONDS - start))s" >&2
    echo "# last state mock_calls: $(printf '%s' "$state" | jq -c '.mock_calls')" >&2
    return 1
}

telegram_render_fixture() {
    local path="$1" bot_id="$2" chat_id="$3" user_id="$4"
    local message_id="${5:-1001}"
    sed \
        -e "s/{{BOT_ID}}/$bot_id/g" \
        -e "s/{{BOT_USERNAME}}/$TELEGRAM_FIXTURE_BOT_USERNAME/g" \
        -e "s/{{CHAT_ID}}/$chat_id/g" \
        -e "s/{{USER_ID}}/$user_id/g" \
        -e "s/{{MESSAGE_ID}}/$message_id/g" \
        -e "s/{{FIRST_NAME}}/$TELEGRAM_FIXTURE_FIRST_NAME/g" \
        "$path"
}
