#!/usr/bin/env bash

# Get the root directory of the test suite
TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load BATS libraries
load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"
load "${TEST_ROOT}/helpers/storage-fixtures"
load "${TEST_ROOT}/helpers/compose-fixtures"

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
        fetch_run_log "$run_id" system
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
    seed_storage_fixture volume "$VOLUME_NAME" "$TEST_VOLUME_DIR/$VOLUME_NAME" >/dev/null
    cd - >/dev/null
}

# Retry fetching run logs until output contains ALL expected strings or timeout.
# Sets $output and $status for subsequent assert_* calls.
# Usage: wait_for_log <run_id> [--agent|--system|--metrics|--network] -- <expected1> [expected2...]
# Example: wait_for_log "$RUN_ID" --system -- "Tool timeout" "WebFetch"
# Example: wait_for_log "$RUN_ID" --network -- "TCP" ":22" ":443"
wait_for_log() {
    local _wfl_run_id=""
    local _wfl_mode="agent"
    local -a _wfl_expected=()
    local _wfl_sep_found=false
    for arg in "$@"; do
        if [[ "$arg" == "--" ]]; then
            _wfl_sep_found=true
        elif $_wfl_sep_found; then
            _wfl_expected+=("$arg")
        elif [[ "$arg" == "--agent" || "$arg" == "--system" || "$arg" == "--metrics" || "$arg" == "--network" ]]; then
            _wfl_mode="${arg#--}"
        else
            _wfl_run_id="$arg"
        fi
    done
    if [[ ${#_wfl_expected[@]} -eq 0 ]]; then
        echo "# wait_for_log: no expected strings after --"
        return 1
    fi
    local _wfl_timeout="${WAIT_FOR_LOG_TIMEOUT:-30}"
    local _wfl_elapsed=0
    while (( _wfl_elapsed < _wfl_timeout )); do
        output="$(fetch_run_log "$_wfl_run_id" "$_wfl_mode" 2>&1)"
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
    if [[ -n "${VM0_API_BACKEND_URL:-}" ]]; then
        case "$VM0_API_BACKEND_URL" in
            http*) printf '%s' "$VM0_API_BACKEND_URL" ;;
            *)     printf 'https://%s' "$VM0_API_BACKEND_URL" ;;
        esac
    else
        jq -r '.apiUrl // "https://api.vm0.ai"' "$HOME/.vm0/config.json"
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

# jq program rendering one network log entry per line, mirroring the text the
# retired `vm0 logs --network` produced so existing substring assertions keep
# matching (protocol upcased, host:port, [firewall-name $], [browser],
# url-rewrite / SECRET (refreshed) auth tags, connector diagnostics, and
# request_headers:/request_body:/response_body: capture lines).
_NETWORK_LOG_JQ='.networkLogs[] |
  [ "[\(.timestamp)]",
    ((.type // "http") | ascii_upcase),
    (.method // empty),
    (.action // empty),
    "\(.host // "unknown"):\(.port // 0)",
    (.url // empty),
    (if .firewall_name then "[\(.firewall_name)\(if .firewall_billable then " $" else "" end)]" else empty end),
    (if .browser_user_agent then "[browser]" else empty end),
    (.error // empty),
    (.firewall_error // empty),
    (if .dns_result then "-> \(.dns_result)" else empty end),
    (if (.connector_diagnostic_type or .connector_diagnostic_reason) then
      "[connector diagnostic: \([(.connector_diagnostic_type // empty), (.connector_diagnostic_reason // empty),
        (if ((.connector_diagnostic_env_names // []) | length) > 0 then "env: \(.connector_diagnostic_env_names | join(", "))" else empty end),
        (if .connector_diagnostic_base then "base: \(.connector_diagnostic_base)" else empty end)] | join("; "))]"
      else empty end),
    (if (.connector_route_reason or (((.connector_route_candidates // []) | length) > 0)) then
      "[connector route: \([(.connector_route_reason // empty),
        (if ((.connector_route_candidates // []) | length) > 0 then "candidates: \(.connector_route_candidates | join(", "))" else empty end)] | join("; "))]"
      else empty end),
    (if .auth_url_rewrite then "url-rewrite" else empty end),
    (if ((.auth_resolved_secrets // []) | length) > 0 then
      ((.auth_refreshed_secrets // []) as $r | (.auth_cache_hit // false) as $c |
        ([.auth_resolved_secrets[] | . + (if IN($r[]) then " (refreshed)" elif $c then " (cached)" else "" end)] | join(", ")))
      else empty end),
    (if .request_headers then "request_headers: \([.request_headers | to_entries[] | "\(.key): \(.value)"] | join(", "))" else empty end),
    (if .request_body then "request_body: \(.request_body)" else empty end),
    (if .response_body then "response_body: \(.response_body)" else empty end)
  ] | join(" ")'

# Fetch a paginated log route, printing each page through a jq extractor.
# Usage: _paginate_run_log <path> <jq_expr>
_paginate_run_log() {
    local path="$1" jq_expr="$2"
    local cursor="" body has_more page=0
    while (( page < 50 )); do
        local url="${path}?limit=100&order=asc"
        [[ -n "$cursor" ]] && url+="&cursor=$(jq -rn --arg c "$cursor" '$c | @uri')"
        body=$(zero_curl "$url") || return 1
        jq -r "$jq_expr" <<< "$body" || return 1
        has_more=$(jq -r '.hasMore' <<< "$body")
        cursor=$(jq -r '.nextCursor // empty' <<< "$body")
        if [[ "$has_more" != "true" || -z "$cursor" ]]; then
            return 0
        fi
        (( page++ ))
    done
}

# Fetch run logs (replacement for the retired `vm0 logs` command).
# Usage: fetch_run_log <run_id> [agent|system|metrics|network]
# - agent:   rendered agent events via `zero logs` (same renderer as vm0 logs)
# - system:  sandbox system log (legacy telemetry route; zero equivalent pending)
# - metrics: resource metrics (legacy telemetry route; zero equivalent pending)
# - network: mitmproxy network log via /api/zero/runs/:id/network
fetch_run_log() {
    local run_id="$1" mode="${2:-agent}"
    case "$mode" in
        agent)
            $ZERO_CLI logs "$run_id" --all
            ;;
        system)
            _paginate_run_log "/api/agent/runs/$run_id/telemetry/system-log" '.systemLog'
            ;;
        metrics)
            _paginate_run_log "/api/agent/runs/$run_id/telemetry/metrics" \
                '.metrics[] | "[\(.ts)] CPU: \(.cpu)% | Mem: \(.mem_used)/\(.mem_total) | Disk: \(.disk_used)/\(.disk_total)"'
            ;;
        network)
            _paginate_run_log "/api/zero/runs/$run_id/network" "$_NETWORK_LOG_JQ"
            ;;
        *)
            echo "fetch_run_log: unknown mode '$mode'" >&2
            return 1
            ;;
    esac
}

create_private_zero_agent() {
    local display_name="$1"
    local payload response agent_id

    payload=$(jq -nc \
        --arg displayName "$display_name" \
        '{displayName: $displayName, visibility: "private"}')
    response=$(zero_curl "/api/zero/agents" -X POST -d "$payload") || return 1
    agent_id=$(printf '%s' "$response" | jq -r '.agentId // empty')
    if [[ -z "$agent_id" ]]; then
        echo "# Failed to extract agentId from zero agent create response" >&2
        echo "# Response: $response" >&2
        return 1
    fi

    printf '%s\n' "$agent_id"
}

zero_usage_runs_response() {
    local run_id="$1"
    zero_curl "/api/zero/usage/runs?runId=$run_id&pageSize=1"
}

zero_run_response() {
    local run_id="$1"
    zero_curl "/api/zero/runs/$run_id"
}

wait_for_zero_run_completed() {
    local run_id="$1"
    local timeout="${2:-100}"
    local interval="${ZERO_RUN_POLL_INTERVAL_S:-2}"
    local start=$SECONDS
    local body=""
    local status_value=""

    while (( SECONDS - start < timeout )); do
        if body=$(zero_run_response "$run_id" 2>&1); then
            status_value=$(printf '%s' "$body" | jq -r '.status // ""')
            case "$status_value" in
                completed)
                    return 0
                    ;;
                failed|timeout|cancelled)
                    echo "# Run $run_id reached terminal status: $status_value" >&2
                    echo "# Run response: $body" >&2
                    return 1
                    ;;
            esac
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for run $run_id to complete" >&2
    echo "# Last run response: $body" >&2
    return 1
}

wait_for_zero_usage_run() {
    local run_id="$1"
    local timeout="${2:-60}"
    local interval="${ZERO_USAGE_POLL_INTERVAL_S:-2}"
    local start=$SECONDS
    local body=""
    local count=""

    while (( SECONDS - start < timeout )); do
        if body=$(zero_usage_runs_response "$run_id" 2>&1); then
            count=$(printf '%s' "$body" | jq -r '.runs | length')
            if [[ "$count" == "1" ]]; then
                printf '%s' "$body" | jq -c '.runs[0]'
                return 0
            fi
        fi
        sleep "$interval"
    done

    echo "# Timed out (${timeout}s) waiting for usage run $run_id" >&2
    echo "# Last usage response: $body" >&2
    echo "# Run response: $(zero_run_response "$run_id" 2>&1 || true)" >&2
    return 1
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

zero_chat_run_with_model() {
    local agent_id="$1"
    local prompt="$2"
    local selected_model="$3"
    local real_agent_in_preview="${4:-false}"
    local payload body

    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg prompt "$prompt" \
        --arg selectedModel "$selected_model" \
        --argjson realAgentInPreview "$real_agent_in_preview" \
        '{agentId: $agentId, prompt: $prompt, model: $selectedModel, hasTextContent: true, realAgentInPreview: $realAgentInPreview}')

    body=$(zero_curl "/api/zero/chat/messages" -X POST -d "$payload")
    LAST_RUN_ID=$(printf '%s' "$body" | jq -r '.runId // ""')
    LAST_THREAD_ID=$(printf '%s' "$body" | jq -r '.threadId // ""')
    export LAST_RUN_ID LAST_THREAD_ID
    [[ -n "$LAST_RUN_ID" && -n "$LAST_THREAD_ID" ]] || {
        echo "# zero_chat_run_with_model: bad response: $body" >&2
        return 1
    }
}

zero_chat_run_with_model_selection() {
    local agent_id="$1"
    local prompt="$2"
    local model_provider_id="$3"
    local selected_model="$4"
    local real_agent_in_preview="${5:-false}"
    local payload body

    payload=$(jq -nc \
        --arg agentId "$agent_id" \
        --arg prompt "$prompt" \
        --arg modelProviderId "$model_provider_id" \
        --arg selectedModel "$selected_model" \
        --argjson realAgentInPreview "$real_agent_in_preview" \
        '{agentId: $agentId, prompt: $prompt, modelSelection: {modelProviderId: $modelProviderId, selectedModel: $selectedModel}, hasTextContent: true, realAgentInPreview: $realAgentInPreview}')

    body=$(zero_curl "/api/zero/chat/messages" -X POST -d "$payload")
    LAST_RUN_ID=$(printf '%s' "$body" | jq -r '.runId // ""')
    LAST_THREAD_ID=$(printf '%s' "$body" | jq -r '.threadId // ""')
    export LAST_RUN_ID LAST_THREAD_ID
    [[ -n "$LAST_RUN_ID" && -n "$LAST_THREAD_ID" ]] || {
        echo "# zero_chat_run_with_model_selection: bad response: $body" >&2
        return 1
    }
}
