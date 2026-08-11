#!/usr/bin/env bats

# Workflow files, agent instructions, and timezone at the runner boundary.

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
    WORKFLOW_ID=""
    PREVIOUS_TIMEZONE=""
}

teardown() {
    if [[ -n "$WORKFLOW_ID" ]]; then
        runner_e2e_delete_workflow "$WORKFLOW_ID" >/dev/null 2>&1 || true
    fi
    if [[ -n "$PREVIOUS_TIMEZONE" ]]; then
        local payload
        payload=$(jq -nc \
            --arg timezone "$PREVIOUS_TIMEZONE" \
            '{timezone: $timezone}')
        runner_api_curl "/api/zero/user-preferences" \
            -X POST \
            -d "$payload" \
            >/dev/null 2>&1 || true
    fi
    runner_e2e_teardown_test
}

@test "t31-1: runner mounts workflow files, instructions, and timezone" {
    run create_runner_agent "e2e-runner-context-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local instruction_marker="AGENT_INSTRUCTION_${TEST_ID}"
    run set_runner_agent_instructions "$AGENT_ID" "$instruction_marker"
    echo "$output"
    assert_success

    run runner_api_curl "/api/zero/user-preferences"
    echo "$output"
    assert_success
    PREVIOUS_TIMEZONE=$(jq -er \
        '.timezone | select(type == "string" and length > 0)' \
        <<<"$output")

    local workflow_name="runner-context-${TEST_ID}"
    local workflow_marker="WORKFLOW_FILE_${TEST_ID}"
    local workflow_payload
    workflow_payload=$(jq -nc \
        --arg agentId "$AGENT_ID" \
        --arg name "$workflow_name" \
        --arg marker "$workflow_marker" '
        {
            agentId: $agentId,
            name: $name,
            instruction: "Use the supplementary context files.",
            files: [
                {path: "context.txt", content: $marker},
                {path: "empty.txt", content: ""}
            ]
        }
    ')
    run runner_api_curl "/api/zero/workflows" \
        -X POST \
        -d "$workflow_payload"
    echo "$output"
    assert_success
    WORKFLOW_ID=$(jq -er '.id | select(type == "string" and length > 0)' <<<"$output")

    run runner_api_curl "/api/zero/user-preferences" \
        -X POST \
        -d '{"timezone":"Asia/Tokyo"}'
    echo "$output"
    assert_success
    run jq -e '.timezone == "Asia/Tokyo"' <<<"$output"
    echo "$output"
    assert_success

    local output_marker="RUNNER_CONTEXT_OK_${TEST_ID}"
    local prompt
    prompt=$(cat <<'EOF'
set -euo pipefail
grep -F '__INSTRUCTION_MARKER__' "$HOME/.codex/AGENTS.md"
grep -F '__WORKFLOW_MARKER__' "$HOME/.codex/skills/__WORKFLOW_NAME__/context.txt"
test ! -s "$HOME/.codex/skills/__WORKFLOW_NAME__/empty.txt"
printf 'TZ=%s\n' "$TZ"
test "$TZ" = 'Asia/Tokyo'
printf '__OUTPUT_MARKER__\n'
EOF
)
    prompt=${prompt//__INSTRUCTION_MARKER__/$instruction_marker}
    prompt=${prompt//__WORKFLOW_MARKER__/$workflow_marker}
    prompt=${prompt//__WORKFLOW_NAME__/$workflow_name}
    prompt=${prompt//__OUTPUT_MARKER__/$output_marker}

    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt"
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId | select(type == "string" and length > 0)' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 180
    echo "$output"
    assert_success

    run runner_e2e_wait_for_agent_text "$RUN_ID" "$output_marker"
    echo "$output"
    assert_success
    assert_output --partial "$instruction_marker"
    assert_output --partial "$workflow_marker"
    assert_output --partial "TZ=Asia/Tokyo"
}
