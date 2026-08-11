#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test agora
}

@test "runner firewall injects Agora placeholders and resolves Basic header auth" {
    run runner_e2e_create_private_agent "runner-firewall-agora-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID=$(jq -er '.agentId' <<<"$output")

    local values
    values=$(jq -nc \
        --arg customerId "e2e-agora-customer-${TEST_ID}" \
        --arg customerSecret "e2e-agora-secret-${TEST_ID}" \
        --arg appId "e2e-agora-app-${TEST_ID}" \
        '{customerId: $customerId, customerSecret: $customerSecret, appId: $appId}')
    run runner_e2e_connect_manual_connector agora api-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success

    local prompt
    prompt=$(cat <<'EOF'
printf 'AGORA_CUSTOMER_ID=%s\n' "$AGORA_CUSTOMER_ID"
printf 'AGORA_CUSTOMER_SECRET=%s\n' "$AGORA_CUSTOMER_SECRET"
printf 'AGORA_APP_ID=%s\n' "$AGORA_APP_ID"
curl --silent --show-error --max-time 5 --output /dev/null https://api.agora.io/dev/v1/projects || true
printf 'AGORA_REQUEST_SENT\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_e2e_wait_for_run_completed "$RUN_ID"
    echo "$output"
    assert_success

    run runner_e2e_wait_for_agent_text "$RUN_ID" AGORA_REQUEST_SENT
    echo "$output"
    assert_success
    assert_output --partial "AGORA_CUSTOMER_ID=4259477b8362c0ffee5afe10ca1c0ff"
    assert_output --partial "AGORA_CUSTOMER_SECRET=c0ffee5afe10ca1c0ffee5afe10ca1c"
    assert_output --partial "AGORA_APP_ID=e2e-agora-app-${TEST_ID}"

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        agora \
        api.agora.io \
        '["AGORA_CUSTOMER_ID","AGORA_CUSTOMER_SECRET"]'
    echo "$output"
    assert_success
}
