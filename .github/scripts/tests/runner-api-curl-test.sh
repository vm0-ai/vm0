#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runner_chat_helper="${repo_root}/e2e/helpers/runner-chat.bash"
# shellcheck source=e2e/helpers/runner-chat.bash
source "$runner_chat_helper"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
stdout_file="${tmp_dir}/stdout"
stderr_file="${tmp_dir}/stderr"
expected_file="${tmp_dir}/expected"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

assert_status() {
    local expected_status="$1"
    if [[ "$request_status" -ne "$expected_status" ]]; then
        fail "expected status ${expected_status}, got ${request_status}"
    fi
}

assert_file_equals() {
    local expected="$1"
    local actual_file="$2"
    printf '%s' "$expected" >"$expected_file"
    diff -u "$expected_file" "$actual_file" || fail "unexpected output in ${actual_file}"
}

assert_file_excludes() {
    local actual_file="$1"
    local sensitive_value="$2"
    if grep -Fq "$sensitive_value" "$actual_file"; then
        fail "sensitive value appeared in ${actual_file}"
    fi
}

curl() {
    local fail_enabled=false
    local saw_fail_with_body=false
    local argument

    for argument in "$@"; do
        case "$argument" in
            --fail-with-body)
                fail_enabled=true
                saw_fail_with_body=true
                ;;
            --no-fail)
                fail_enabled=false
                ;;
        esac
    done

    [[ "$saw_fail_with_body" == true ]] || {
        echo "curl did not receive --fail-with-body" >&2
        return 90
    }
    [[ "${!#}" == "$MOCK_CURL_EXPECTED_URL" ]] || {
        echo "curl received an unexpected request URL" >&2
        return 91
    }

    case "$MOCK_CURL_MODE" in
        success)
            printf '{"ok":true}\n'
            ;;
        failure)
            printf '{"error":"rate limited"}\n'
            echo "curl: (22) The requested URL returned error: 429" >&2
            return 22
            ;;
        no-fail)
            [[ "$fail_enabled" == false ]] || {
                echo "caller --no-fail did not override --fail-with-body" >&2
                return 92
            }
            printf '{"error":"handled"}\n409'
            ;;
        *)
            echo "unexpected mock curl mode: $MOCK_CURL_MODE" >&2
            return 93
            ;;
    esac
}

run_request() {
    if runner_api_curl "$@" >"$stdout_file" 2>"$stderr_file"; then
        request_status=0
    else
        request_status=$?
    fi
}

export E2E_API_URL="https://pr-27981-api.vm6.ai/"
export E2E_API_TOKEN="sensitive-api-token"
export VERCEL_AUTOMATION_BYPASS_SECRET="sensitive-bypass-secret"
payload='{"secret":"sensitive-request-payload"}'

MOCK_CURL_MODE=success
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/okou/chat/events"
run_request "/api/okou/chat/events" -X POST -d "$payload"
assert_status 0
assert_file_equals $'{"ok":true}\n' "$stdout_file"
assert_file_equals '' "$stderr_file"

MOCK_CURL_MODE=failure
run_request "/api/okou/chat/events" -X POST -d "$payload"
assert_status 22
assert_file_equals $'{"error":"rate limited"}\n' "$stdout_file"
assert_file_equals \
    $'curl: (22) The requested URL returned error: 429\nrunner_api_curl failed: url=https://pr-27981-api.vm6.ai/api/okou/chat/events curl_status=22\n' \
    "$stderr_file"
assert_file_excludes "$stderr_file" "$E2E_API_TOKEN"
assert_file_excludes "$stderr_file" "$VERCEL_AUTOMATION_BYPASS_SECRET"
assert_file_excludes "$stderr_file" "sensitive-request-payload"

MOCK_CURL_MODE=no-fail
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/okou/agents/agent-1"
run_request \
    "/api/okou/agents/agent-1" \
    --no-fail \
    --write-out $'\n%{http_code}'
assert_status 0
assert_file_equals $'{"error":"handled"}\n409' "$stdout_file"
assert_file_equals '' "$stderr_file"

echo "runner_api_curl tests passed"
