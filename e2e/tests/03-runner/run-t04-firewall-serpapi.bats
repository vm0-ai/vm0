#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test serpapi
}

@test "runner firewall injects the SerpApi query authentication" {
    run create_runner_agent "runner-firewall-serpapi-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local values
    values=$(jq -nc --arg apiKey "e2e-serpapi-token-${TEST_ID}" '{apiKey: $apiKey}')
    run runner_e2e_connect_manual_connector serpapi api-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
printf 'SERPAPI_TOKEN=%s\n' "$SERPAPI_TOKEN"
# Raw DNS has dedicated runner coverage. Keep this firewall-auth probe on IPv4
# so an unavailable AAAA response cannot block an otherwise valid request.
curl --ipv4 --silent --show-error --max-time 5 \
    --output /dev/null \
    'https://serpapi.com/search?q=vm0-e2e&engine=google'
printf 'SERPAPI_REQUEST_SENT\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text "$THREAD_ID" "$RUN_ID" SERPAPI_REQUEST_SENT
    echo "$output"
    assert_success
    assert_output --partial "SERPAPI_TOKEN=CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCof"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        serpapi \
        serpapi.com \
        '["SERPAPI_TOKEN"]'
    echo "$output"
    assert_success
}
