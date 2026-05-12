#!/usr/bin/env bash

# Get the root directory of the test suite
TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load BATS libraries
load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"

# Path to CLI binaries (trace wrappers log each invocation for timeout debugging)
export VM0_CLI="${TEST_ROOT}/helpers/trace-vm0.sh"
export ZERO_CLI="${TEST_ROOT}/helpers/trace-zero.sh"

# Show system logs when test fails
# This hook is called by BATS before teardown() when a test fails
bats::on_failure() {
    local run_id
    run_id=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | tail -1)
    if [[ -n "$run_id" ]]; then
        echo "# === System logs for failed run ($run_id) ==="
        $VM0_CLI logs "$run_id" --system
    fi
}

# Create a test volume with unique name
# Usage: create_test_volume "prefix"
# Sets: TEST_VOLUME_DIR, VOLUME_NAME
create_test_volume() {
    local prefix="${1:-e2e-vol}"
    export TEST_VOLUME_DIR="$(mktemp -d)"
    export VOLUME_NAME="${prefix}-$(date +%s%3N)-$RANDOM"

    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null
}

# Retry `vm0 logs --all` until output contains ALL expected strings or timeout.
# Sets $output and $status for subsequent assert_* calls.
# Automatically appends --all to fetch complete logs on each attempt.
# Usage: wait_for_log [vm0 logs args...] -- <expected1> [expected2...]
# Example: wait_for_log "$RUN_ID" --system -- "Tool timeout" "WebFetch"
# Example: wait_for_log "$RUN_ID" --network -- "TCP" ":22" ":443"
wait_for_log() {
    local -a _wfl_args=()
    local -a _wfl_expected=()
    local _wfl_sep_found=false
    for arg in "$@"; do
        if [[ "$arg" == "--" ]]; then
            _wfl_sep_found=true
        elif $_wfl_sep_found; then
            _wfl_expected+=("$arg")
        else
            _wfl_args+=("$arg")
        fi
    done
    if [[ ${#_wfl_expected[@]} -eq 0 ]]; then
        echo "# wait_for_log: no expected strings after --"
        return 1
    fi
    local _wfl_timeout="${WAIT_FOR_LOG_TIMEOUT:-30}"
    local _wfl_elapsed=0
    while (( _wfl_elapsed < _wfl_timeout )); do
        # Append --all for non-search commands to fetch complete logs
        if [[ "${_wfl_args[0]:-}" == "search" ]]; then
            output="$($VM0_CLI logs "${_wfl_args[@]}" 2>&1)"
        else
            output="$($VM0_CLI logs "${_wfl_args[@]}" --all 2>&1)"
        fi
        status=$?
        if [[ "$status" -eq 0 ]]; then
            local _wfl_all=true
            for _wfl_e in "${_wfl_expected[@]}"; do
                if [[ "$output" != *"$_wfl_e"* ]]; then
                    _wfl_all=false
                    break
                fi
            done
            if $_wfl_all; then
                return 0
            fi
        fi
        sleep 2
        (( _wfl_elapsed += 2 ))
    done
    echo "# Timed out (${_wfl_timeout}s) waiting for log containing: ${_wfl_expected[*]}"
    echo "# Last output: $output"
    return 1
}

# Cleanup test volume directory
cleanup_test_volume() {
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}

zero_auth_token() {
    if [[ -n "${ZERO_TOKEN:-}" ]]; then
        printf '%s' "$ZERO_TOKEN"
    elif [[ -n "${VM0_TOKEN:-}" ]]; then
        printf '%s' "$VM0_TOKEN"
    else
        jq -r '.token // empty' "$HOME/.vm0/config.json"
    fi
}

zero_api_url() {
    if [[ -n "${VM0_API_URL:-}" ]]; then
        case "$VM0_API_URL" in
            http*) printf '%s' "$VM0_API_URL" ;;
            *)     printf 'https://%s' "$VM0_API_URL" ;;
        esac
    else
        jq -r '.apiUrl // "https://www.vm0.ai"' "$HOME/.vm0/config.json"
    fi
}

zero_curl() {
    local path="$1"; shift
    local token base
    token=$(zero_auth_token)
    base=$(zero_api_url)
    local -a hdrs=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        hdrs+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl -fsS "${hdrs[@]}" "$@" "$base$path"
}

zero_model_provider_id_by_type() {
    local provider_type="$1"
    local body provider_id
    body=$(zero_curl "/api/zero/model-providers")
    provider_id=$(printf '%s' "$body" \
        | jq -r --arg type "$provider_type" \
            '.modelProviders[] | select(.type == $type) | .id' \
        | head -1)
    if [[ -z "$provider_id" || "$provider_id" == "null" ]]; then
        echo "# No org model provider found for type: $provider_type" >&2
        return 1
    fi
    printf '%s' "$provider_id"
}

zero_model_first_selection_provider_id() {
    printf '%s' "00000000-0000-4000-8000-000000000000"
}

zero_chat_run_with_model_selection() {
    local agent_id="$1"
    local prompt="$2"
    local model_provider_id="$3"
    local selected_model="$4"
    local debug_no_mock_claude="${5:-false}"
    local debug_no_mock_codex="${6:-false}"
    local payload body

    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg prompt "$prompt" \
        --arg modelProviderId "$model_provider_id" \
        --arg selectedModel "$selected_model" \
        --argjson debugNoMockClaude "$debug_no_mock_claude" \
        --argjson debugNoMockCodex "$debug_no_mock_codex" \
        '{agentId: $agentId, prompt: $prompt, modelSelection: {modelProviderId: $modelProviderId, selectedModel: $selectedModel}, hasTextContent: true, debugNoMockClaude: $debugNoMockClaude, debugNoMockCodex: $debugNoMockCodex}')

    body=$(zero_curl "/api/zero/chat/messages" -X POST -d "$payload")
    LAST_RUN_ID=$(printf '%s' "$body" | jq -r '.runId // ""')
    LAST_THREAD_ID=$(printf '%s' "$body" | jq -r '.threadId // ""')
    export LAST_RUN_ID LAST_THREAD_ID
    [[ -n "$LAST_RUN_ID" && -n "$LAST_THREAD_ID" ]] || {
        echo "# zero_chat_run_with_model_selection: bad response: $body" >&2
        return 1
    }
}
