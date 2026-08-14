#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
    CUSTOM_CONNECTOR_ID=""
}

teardown() {
    runner_e2e_teardown_test
    if [[ -n "${CUSTOM_CONNECTOR_ID:-}" ]]; then
        runner_api_curl "/api/okou/custom-connectors/${CUSTOM_CONNECTOR_ID}" \
            -X DELETE \
            >/dev/null 2>&1 || true
    fi
}

@test "runner resolves custom connector credentials for an outbound request" {
    run create_runner_agent "runner-custom-connector-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local connector_slug="_runner-probe-${TEST_ID}"
    local connector_payload
    connector_payload=$(jq -nc \
        --arg slug "$connector_slug" \
        --arg prefix "https://www.google.com/" \
        '{
            slug: $slug,
            kind: "http",
            displayName: "Runner Credential Probe",
            prefixTemplates: [$prefix],
            fields: [{
                key: "probe_secret",
                label: "Probe secret",
                kind: "secret",
                required: true
            }],
            headerInjections: [{
                name: "X-Okou-Custom-Connector-Probe",
                valueTemplate: "{{secrets.probe_secret}}"
            }],
            queryInjections: [],
            authMode: "manual"
        }')
    run runner_api_curl "/api/okou/custom-connectors" \
        -X POST \
        -d "$connector_payload"
    echo "$output"
    assert_success
    CUSTOM_CONNECTOR_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")

    local probe_secret
    probe_secret="e2e-custom-connector-$(_runner_uuid)"
    local values_payload
    values_payload=$(jq -nc \
        --arg secret "$probe_secret" \
        '{values: [{key: "probe_secret", kind: "secret", value: $secret}]}')
    run runner_api_curl \
        "/api/okou/custom-connectors/${CUSTOM_CONNECTOR_ID}/values" \
        -X PUT \
        -d "$values_payload"
    assert_success
    run jq -e '
        .connected == true and
        .missingRequiredFields == [] and
        .configuredFieldKeys == ["probe_secret"]
    ' <<<"$output"
    assert_success

    local grants_payload
    grants_payload=$(jq -nc \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" \
        '{
            operation: "replace",
            grants: [{
                customConnectorId: $customConnectorId,
                permissionNames: []
            }]
        }')
    run runner_api_curl "/api/okou/agents/${AGENT_ID}/custom-connectors" \
        -X PUT \
        -d "$grants_payload"
    echo "$output"
    assert_success
    run jq -e \
        --arg customConnectorId "$CUSTOM_CONNECTOR_ID" '
            .grants == [{
                customConnectorId: $customConnectorId,
                permissionNames: []
            }]
        ' <<<"$output"
    assert_success

    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
curl --silent --show-error --max-time 10 \
    --output /dev/null \
    'https://www.google.com/robots.txt' || true
printf 'CUSTOM_CONNECTOR_REQUEST_SENT\n'
EOF
)

    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er \
        '.runId | select(type == "string" and length > 0)' \
        <<<"$output")
    THREAD_ID=$(jq -er \
        '.threadId | select(type == "string" and length > 0)' \
        <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        CUSTOM_CONNECTOR_REQUEST_SENT
    echo "$output"
    assert_success

    local compact_connector_id="${CUSTOM_CONNECTOR_ID//-/}"
    local firewall_name="custom_connector_${compact_connector_id}"
    local secret_key="CUSTOM_${compact_connector_id}_S_PROBE_SECRET"
    local expected_secrets
    expected_secrets=$(jq -nc --arg secretKey "$secret_key" '[$secretKey]')
    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        "$firewall_name" \
        www.google.com \
        "$expected_secrets"
    echo "$output"
    assert_success
}
