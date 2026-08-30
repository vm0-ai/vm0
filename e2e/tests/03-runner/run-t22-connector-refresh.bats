#!/usr/bin/env bats

# Connector credential replacement across same-thread continuation.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test bentoml
}

@test "continued runner session refreshes replaced connector credentials" {
    run create_runner_agent "runner-connector-refresh-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local initial_secret="e2e-bentoml-initial-$(_runner_uuid)"
    local updated_secret="e2e-bentoml-updated-$(_runner_uuid)"
    local initial_endpoint="https://bentoml.com"
    local updated_endpoint="https://cloud.bentoml.com"
    local initial_endpoint_digest updated_endpoint_digest
    initial_endpoint_digest=$(printf '%s' "$initial_endpoint" | sha256sum | cut -d' ' -f1)
    updated_endpoint_digest=$(printf '%s' "$updated_endpoint" | sha256sum | cut -d' ' -f1)

    local values public_surfaces=''
    values=$(jq -nc \
        --arg apiToken "$initial_secret" \
        --arg endpoint "$initial_endpoint" \
        '{apiToken: $apiToken, endpoint: $endpoint}')
    run runner_e2e_connect_manual_connector \
        bentoml \
        api-token \
        "$AGENT_ID" \
        "$values"
    echo "$output"
    assert_success
    CONNECTOR_ACCOUNT_ID=$(jq -er \
        '.id | select(type == "string" and length > 0)' \
        <<<"$output")
    public_surfaces+="$output"$'\n'

    local probe_template
    probe_template=$(cat <<'EOF'
set -euo pipefail
printf 'BENTOML_API_KEY=%s\n' "$BENTO_CLOUD_API_KEY"
printf 'BENTOML_ENDPOINT_SHA256='
printf '%s' "$BENTO_CLOUD_API_ENDPOINT" | sha256sum | cut -d' ' -f1
curl --silent --show-error --max-time 5 \
    --output /dev/null \
    "${BENTO_CLOUD_API_ENDPOINT}/" || true
printf '__OUTPUT_MARKER__\n'
EOF
)

    local first_output_marker="BENTOML_INITIAL_REQUEST_SENT_${TEST_ID}"
    local first_prompt="${probe_template//__OUTPUT_MARKER__/$first_output_marker}"
    run runner_e2e_start_chat_run "$AGENT_ID" "$first_prompt"
    echo "$output"
    assert_success
    local first_send_response="$output"
    public_surfaces+="$first_send_response"$'\n'
    local first_run_id
    first_run_id=$(jq -er '.runId | select(type == "string" and length > 0)' \
        <<<"$first_send_response")
    RUN_ID="$first_run_id"
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' \
        <<<"$first_send_response")

    run runner_wait_for_run "$first_run_id" 180
    echo "$output"
    assert_success
    local first_run_response="$output"
    public_surfaces+="$first_run_response"$'\n'
    local first_session_id
    first_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$first_run_response")

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$first_run_id" \
        "$first_output_marker"
    echo "$output"
    assert_success
    local first_agent_text="$output"
    public_surfaces+="$first_agent_text"$'\n'
    assert_output --partial \
        "BENTOML_API_KEY=cur7hCoffeeSafeLocalCoffeeSafeLocalCoffeeSafe"
    assert_output --partial "BENTOML_ENDPOINT_SHA256=${initial_endpoint_digest}"
    refute_output --partial "BENTOML_ENDPOINT_SHA256=${updated_endpoint_digest}"

    run runner_api_curl "/api/runs/${first_run_id}/context"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_firewall_log \
        "$first_run_id" \
        bentoml \
        bentoml.com \
        '["BENTO_CLOUD_API_KEY"]'
    echo "$output"
    assert_success
    local first_network_logs="$output"
    public_surfaces+="$first_network_logs"$'\n'
    run jq -e --arg unexpectedHost cloud.bentoml.com '
        all(.[];
            .firewall_name != "bentoml" or
            .host != $unexpectedHost
        )
    ' <<<"$first_network_logs"
    echo "$output"
    assert_success

    values=$(jq -nc \
        --arg apiToken "$updated_secret" \
        --arg endpoint "$updated_endpoint" \
        '{apiToken: $apiToken, endpoint: $endpoint}')
    run runner_e2e_connect_manual_connector \
        bentoml \
        api-token \
        "$AGENT_ID" \
        "$values" \
        "$CONNECTOR_ACCOUNT_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    local updated_output_marker="BENTOML_UPDATED_REQUEST_SENT_${TEST_ID}"
    local updated_prompt="${probe_template//__OUTPUT_MARKER__/$updated_output_marker}"
    run runner_e2e_continue_chat_run \
        "$AGENT_ID" \
        "$THREAD_ID" \
        "$updated_prompt"
    echo "$output"
    assert_success
    local updated_send_response="$output"
    public_surfaces+="$updated_send_response"$'\n'
    run jq -e --arg threadId "$THREAD_ID" --arg firstRunId "$first_run_id" '
        .threadId == $threadId and
        (.runId | type == "string" and length > 0) and
        .runId != $firstRunId
    ' <<<"$updated_send_response"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId' <<<"$updated_send_response")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success
    local updated_run_response="$output"
    public_surfaces+="$updated_run_response"$'\n'
    local updated_session_id
    updated_session_id=$(jq -er \
        '.result.agentSessionId | select(type == "string" and length > 0)' \
        <<<"$updated_run_response")
    [[ "$updated_session_id" == "$first_session_id" ]]

    run runner_e2e_wait_for_chat_text \
        "$THREAD_ID" \
        "$RUN_ID" \
        "$updated_output_marker"
    echo "$output"
    assert_success
    local updated_agent_text="$output"
    public_surfaces+="$updated_agent_text"$'\n'
    assert_output --partial \
        "BENTOML_API_KEY=cur7hCoffeeSafeLocalCoffeeSafeLocalCoffeeSafe"
    assert_output --partial "BENTOML_ENDPOINT_SHA256=${updated_endpoint_digest}"
    refute_output --partial "BENTOML_ENDPOINT_SHA256=${initial_endpoint_digest}"

    run runner_api_curl "/api/runs/${RUN_ID}/context"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    run runner_e2e_wait_for_firewall_log \
        "$RUN_ID" \
        bentoml \
        cloud.bentoml.com \
        '["BENTO_CLOUD_API_KEY"]'
    echo "$output"
    assert_success
    local updated_network_logs="$output"
    public_surfaces+="$updated_network_logs"$'\n'
    run jq -e --arg unexpectedHost bentoml.com '
        all(.[];
            .firewall_name != "bentoml" or
            .host != $unexpectedHost
        )
    ' <<<"$updated_network_logs"
    echo "$output"
    assert_success

    run runner_chat_event_rows "$THREAD_ID"
    echo "$output"
    assert_success
    public_surfaces+="$output"$'\n'

    local raw_secret
    for raw_secret in "$initial_secret" "$updated_secret"; do
        if [[ "$public_surfaces" == *"$raw_secret"* ]]; then
            fail "raw BentoML credential appeared in a public runner surface"
        fi
    done
}
