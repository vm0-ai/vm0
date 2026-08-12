#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test agora
}

@test "runner firewall resolves Agora auth without exposing raw credentials" {
    run create_runner_agent "runner-firewall-agora-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local customer_id="e2e-agora-customer-${TEST_ID}"
    local customer_secret="e2e-agora-secret-${TEST_ID}"
    local values public_surfaces
    values=$(jq -nc \
        --arg customerId "$customer_id" \
        --arg customerSecret "$customer_secret" \
        --arg appId "e2e-agora-app-${TEST_ID}" \
        '{customerId: $customerId, customerSecret: $customerSecret, appId: $appId}')
    run runner_e2e_connect_manual_connector agora api-token "$AGENT_ID" "$values"
    echo "$output"
    assert_success
    public_surfaces="$output"$'\n'

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
    public_surfaces+="$output"$'\n'
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_agent_text "$RUN_ID" AGORA_REQUEST_SENT
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'
    assert_output --partial "AGORA_CUSTOMER_ID=4259477b8362c0ffee5afe10ca1c0ff"
    assert_output --partial "AGORA_CUSTOMER_SECRET=c0ffee5afe10ca1c0ffee5afe10ca1c"
    assert_output --partial "AGORA_APP_ID=e2e-agora-app-${TEST_ID}"

    run runner_api_curl "/api/okou/runs/${RUN_ID}/context"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_api_curl "/api/okou/chat-threads/${THREAD_ID}/events?limit=50"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_agent_events "$RUN_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        agora \
        api.agora.io \
        '["AGORA_CUSTOMER_ID","AGORA_CUSTOMER_SECRET"]'
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    local raw_credential
    for raw_credential in "$customer_id" "$customer_secret"; do
        if [[ "$public_surfaces" == *"$raw_credential"* ]]; then
            fail "raw Agora credential appeared in a public runner surface"
        fi
    done
}
