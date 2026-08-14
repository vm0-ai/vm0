#!/usr/bin/env bats

# Real VM0-managed Pi loop smoke test through supported agent and chat APIs.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

BATS_TEST_TIMEOUT=600

setup_file() {
    local credentials="/tmp/e2e-api-credentials-runner-real-pi.json"
    export E2E_API_TOKEN E2E_API_URL
    E2E_API_TOKEN="$(jq -er '.token | select(type == "string" and length > 0)' "$credentials")"
    E2E_API_URL="$(jq -er '.apiUrl | select(type == "string" and length > 0)' "$credentials")"
    runner_e2e_require_environment

    export RUNNER_AGENT_ID
    RUNNER_AGENT_ID="$(create_runner_agent \
        "e2e-real-pi-$(date +%s%3N)-$RANDOM")"
    set_runner_agent_instructions \
        "$RUNNER_AGENT_ID" \
        "Real Pi loop smoke test instructions."
}

teardown_file() {
    if [[ -n "${RUNNER_AGENT_ID:-}" ]]; then
        delete_runner_agent "$RUNNER_AGENT_ID"
    fi
}

@test "vm0-managed real pi loop returns a successful answer" {
    run runner_api_curl "/api/okou/model-policies"
    echo "$output"
    assert_success
    run jq -e '
        any(.policies[]?;
            .model == "deepseek-v4-flash" and
            .defaultProviderType == "vm0" and
            .credentialScope == "org" and
            .modelProviderId == null
        )
    ' <<<"$output"
    echo "$output"
    assert_success

    run runner_chat_send \
        "$RUNNER_AGENT_ID" \
        "123+456. Reply only RESULT=<answer>." \
        "" \
        "deepseek-v4-flash"
    echo "$output"
    assert_success
    local run_id thread_id
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")"
    thread_id="$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")"

    run runner_wait_for_run "$run_id" 180
    echo "$output"
    assert_success
    run jq -e '
        .status == "completed" and
        (.result.agentSessionId | type == "string" and length > 0)
    ' <<<"$output"
    echo "$output"
    assert_success

    run runner_api_curl "/api/okou/runs/${run_id}/context"
    echo "$output"
    assert_success
    run jq -e '.cliAgentType == "pi"' <<<"$output"
    echo "$output"
    assert_success

    run _wait_for_runner_chat_completion "$thread_id" "$run_id" 60
    echo "$output"
    assert_success
    assert_output --partial "RESULT=579"
}
