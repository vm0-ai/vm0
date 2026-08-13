#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
    CUSTOM_CONNECTOR_ID=""
    WEBHOOK_TOKEN=""
}

teardown() {
    runner_e2e_teardown_test
    if [[ -n "${CUSTOM_CONNECTOR_ID:-}" ]]; then
        runner_api_curl "/api/okou/custom-connectors/${CUSTOM_CONNECTOR_ID}" \
            -X DELETE \
            >/dev/null 2>&1 || true
    fi
    if [[ -n "${WEBHOOK_TOKEN:-}" ]]; then
        curl -fsS \
            --connect-timeout 10 \
            --max-time 20 \
            -X DELETE \
            "https://webhook.site/token/${WEBHOOK_TOKEN}" \
            >/dev/null 2>&1 || true
    fi
}

wait_for_webhook_request() {
    local token="$1"
    local marker="$2"
    local expected_header="$3"
    local timeout_seconds="${4:-30}"
    local started_at=$SECONDS
    local response='{}'

    while ((SECONDS - started_at < timeout_seconds)); do
        if response=$(curl -fsS \
            --connect-timeout 10 \
            --max-time 20 \
            "https://webhook.site/token/${token}/request/latest" \
            2>/dev/null); then
            if ! jq -e \
                --arg marker "$marker" \
                --arg expectedHeader "$expected_header" '
                    .method == "POST" and
                    ((.content | fromjson) | .marker == $marker) and
                    ([
                        .headers
                        | to_entries[]
                        | select(
                            (.key | ascii_downcase) ==
                            "x-okou-custom-connector-probe"
                        )
                        | .value[]?
                    ] | any(. == $expectedHeader))
                ' <<<"$response" >/dev/null; then
                echo "Webhook.site captured an unexpected custom connector request" >&2
                return 1
            fi
            jq -cn --arg marker "$marker" '{
                method: "POST",
                marker: $marker,
                credentialHeaderInjected: true
            }'
            return 0
        fi
        sleep 1
    done

    echo "Timed out waiting for the custom connector request at Webhook.site" >&2
    return 1
}

@test "runner delivers a custom connector request with injected credentials" {
    run create_runner_agent "runner-custom-connector-webhook-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local webhook_response
    run curl -fsS \
        --connect-timeout 10 \
        --max-time 20 \
        -X POST \
        -H 'Content-Type: application/json' \
        -d '{"default_status":200,"default_content":"ok","default_content_type":"text/plain"}' \
        https://webhook.site/token
    assert_success
    webhook_response="$output"
    WEBHOOK_TOKEN=$(jq -er \
        '.uuid | select(type == "string" and length == 36)' \
        <<<"$webhook_response")

    local connector_slug="_webhook-site-${TEST_ID}"
    local connector_payload
    connector_payload=$(jq -nc \
        --arg slug "$connector_slug" \
        --arg prefix "https://webhook.site/${WEBHOOK_TOKEN}/" \
        '{
            slug: $slug,
            kind: "http",
            displayName: "Runner Webhook Probe",
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
    probe_secret="e2e-webhook-$(_runner_uuid)"
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

    local marker="custom-connector-webhook-${TEST_ID}"
    local request_url="https://webhook.site/${WEBHOOK_TOKEN}/"
    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
curl --fail --silent --show-error --max-time 10 \
    --request POST \
    --header 'Content-Type: application/json' \
    --data '{"marker":"__MARKER__"}' \
    --output /dev/null \
    '__REQUEST_URL__'
printf '__OUTPUT_MARKER__\n'
EOF
)
    prompt=${prompt//__MARKER__/$marker}
    prompt=${prompt//__REQUEST_URL__/$request_url}
    prompt=${prompt//__OUTPUT_MARKER__/CUSTOM_CONNECTOR_REQUEST_SENT}

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

    run wait_for_webhook_request \
        "$WEBHOOK_TOKEN" \
        "$marker" \
        "$probe_secret"
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
        webhook.site \
        "$expected_secrets"
    echo "$output"
    assert_success
}
