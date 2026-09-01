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
attempts_file="${tmp_dir}/curl-attempts"

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

# The mocked curl runs inside a command substitution, so its attempt counter
# lives in a file rather than a shell variable.
reset_curl_attempts() {
    printf '0' >"$attempts_file"
}

record_curl_attempt() {
    local attempts
    attempts="$(<"$attempts_file")"
    attempts=$((attempts + 1))
    printf '%s' "$attempts" >"$attempts_file"
    printf '%s' "$attempts"
}

assert_curl_attempts() {
    local expected="$1"
    local actual
    actual="$(<"$attempts_file")"
    if [[ "$actual" != "$expected" ]]; then
        fail "expected ${expected} curl attempt(s), got ${actual}"
    fi
}

curl() {
    local request_url="${!#}"
    local fail_with_body_enabled=false
    local saw_fail_with_body=false
    local saw_no_fail_with_body=false
    local saw_vercel_write_out=false
    local write_out=''

    while (($# > 0)); do
        case "$1" in
            --fail-with-body)
                fail_with_body_enabled=true
                saw_fail_with_body=true
                ;;
            --no-fail)
                ;;
            --no-fail-with-body)
                fail_with_body_enabled=false
                saw_no_fail_with_body=true
                ;;
            --write-out)
                shift
                write_out="$1"
                if [[ "$write_out" == "$MOCK_CURL_EXPECTED_VERCEL_WRITE_OUT" ]]; then
                    saw_vercel_write_out=true
                fi
                ;;
        esac
        shift
    done

    [[ "$saw_fail_with_body" == true ]] || {
        echo "curl did not receive --fail-with-body" >&2
        return 90
    }
    [[ "$saw_vercel_write_out" == true ]] || {
        echo "curl did not receive the Vercel log write-out" >&2
        return 91
    }
    [[ "$request_url" == "$MOCK_CURL_EXPECTED_URL" ]] || {
        echo "curl received an unexpected request URL" >&2
        return 92
    }

    case "$MOCK_CURL_MODE" in
        success)
            printf '{"ok":true}\n'
            ;;
        failure)
            [[ "$fail_with_body_enabled" == true ]] || {
                echo "curl failure mode did not retain --fail-with-body" >&2
                return 93
            }
            printf '{"error":"rate limited"}\n'
            echo "curl: (22) The requested URL returned error: 429" >&2
            echo "Vercel logs: $MOCK_CURL_EXPECTED_VERCEL_URL" >&2
            return 22
            ;;
        no-response | no-response-then-success)
            local attempt
            attempt="$(record_curl_attempt)"
            if [[ "$MOCK_CURL_MODE" == "no-response-then-success" ]] &&
                ((attempt > 1)); then
                printf '{"ok":true}\n'
                return 0
            fi
            echo "curl: (28) Operation timed out after 30002 milliseconds with 0 bytes received" >&2
            echo "Vercel logs: $MOCK_CURL_EXPECTED_VERCEL_URL" >&2
            return 28
            ;;
        no-fail-with-body | no-fail-with-body-failure)
            [[ "$saw_no_fail_with_body" == true ]] || {
                echo "curl did not receive --no-fail-with-body" >&2
                return 94
            }
            [[ "$fail_with_body_enabled" == false ]] || {
                echo "caller --no-fail-with-body did not override --fail-with-body" >&2
                return 95
            }
            [[ "$write_out" == $'\n%{http_code}' ]] || {
                echo "curl did not retain the caller write-out" >&2
                return 96
            }
            if [[ "$MOCK_CURL_MODE" == "no-fail-with-body" ]]; then
                printf '{"error":{"message":"Cannot delete agent while its configuration is being migrated","code":"CONFLICT"}}\n409'
            else
                printf '{"error":"Internal server error"}\n500'
            fi
            ;;
        *)
            echo "unexpected mock curl mode: $MOCK_CURL_MODE" >&2
            return 97
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

run_agent_teardown() {
    if delete_runner_agent_for_stage0_teardown "$1" \
        >"$stdout_file" 2>"$stderr_file"; then
        request_status=0
    else
        request_status=$?
    fi
}

export E2E_API_URL="https://pr-27981-api.vm6.ai/"
export E2E_API_TOKEN="sensitive-api-token"
export VERCEL_AUTOMATION_BYPASS_SECRET="sensitive-bypass-secret"
payload='{"secret":"sensitive-request-payload"}'
MOCK_CURL_EXPECTED_VERCEL_URL='https://vercel.com/okou/vm0-api/logs?search=requestHost%3Apr-27981-api.vm6.ai+requestPath%3A%2Fapi%2Fchat%2Fevents+status%3A429&timeline=past12Hours'
MOCK_CURL_EXPECTED_VERCEL_WRITE_OUT='%{onerror}%{stderr}Vercel logs: https://vercel.com/okou/vm0-api/logs?search=requestHost%%3Apr-27981-api.vm6.ai+requestPath%%3A%%2Fapi%%2Fchat%%2Fevents+status%%3A%{http_code}&timeline=past12Hours\n'

MOCK_CURL_MODE=success
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/chat/events"
run_request "/api/chat/events" -X POST -d "$payload"
assert_status 0
assert_file_equals $'{"ok":true}\n' "$stdout_file"
assert_file_equals '' "$stderr_file"

MOCK_CURL_MODE=failure
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/chat/events?cursor=sensitive-query-value"
run_request "/api/chat/events?cursor=sensitive-query-value" -X POST -d "$payload"
assert_status 22
assert_file_equals $'{"error":"rate limited"}\n' "$stdout_file"
assert_file_equals \
    $'curl: (22) The requested URL returned error: 429\nVercel logs: '"$MOCK_CURL_EXPECTED_VERCEL_URL"$'\nrunner_api_curl failed: url=https://pr-27981-api.vm6.ai/api/chat/events curl_status=22\n' \
    "$stderr_file"
assert_file_excludes "$stderr_file" "$E2E_API_TOKEN"
assert_file_excludes "$stderr_file" "$VERCEL_AUTOMATION_BYPASS_SECRET"
assert_file_excludes "$stderr_file" "sensitive-request-payload"
assert_file_excludes "$stderr_file" "sensitive-query-value"

MOCK_CURL_MODE=no-fail-with-body
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/agents/agent-1"
MOCK_CURL_EXPECTED_VERCEL_WRITE_OUT='%{onerror}%{stderr}Vercel logs: https://vercel.com/okou/vm0-api/logs?search=requestHost%%3Apr-27981-api.vm6.ai+requestPath%%3A%%2Fapi%%2Fagents%%2Fagent-1+status%%3A%{http_code}&timeline=past12Hours\n'
run_agent_teardown "agent-1"
assert_status 0
assert_file_equals '' "$stdout_file"
assert_file_equals '' "$stderr_file"

MOCK_CURL_MODE=no-fail-with-body-failure
run_agent_teardown "agent-1"
assert_status 1
assert_file_equals '' "$stdout_file"
assert_file_equals \
    $'Stage 0 Runner E2E agent teardown failed with HTTP 500: {"error":"Internal server error"}\nVercel logs: https://vercel.com/okou/vm0-api/logs?search=requestHost%3Apr-27981-api.vm6.ai+requestPath%3A%2Fapi%2Fagents%2Fagent-1+status%3A500&timeline=past12Hours\n' \
    "$stderr_file"
assert_file_excludes "$stderr_file" "$E2E_API_TOKEN"
assert_file_excludes "$stderr_file" "$VERCEL_AUTOMATION_BYPASS_SECRET"
assert_file_excludes "$stderr_file" "sensitive-request-payload"

# A stalled request produces no response at all, so a plain GET is sent again.
# See the merge-group Turbo run 33464652878, where four runner shards gave up
# on GET /api/runs/:id/context after 30s while the API answered 200 in 30-44s.
context_vercel_logs_search='https://vercel.com/okou/vm0-api/logs?search=requestHost%3Apr-27981-api.vm6.ai+requestPath%3A%2Fapi%2Fruns%2Frun-1%2Fcontext'
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/runs/run-1/context"
MOCK_CURL_EXPECTED_VERCEL_URL="${context_vercel_logs_search}+status%3A000&timeline=past12Hours"
MOCK_CURL_EXPECTED_VERCEL_WRITE_OUT='%{onerror}%{stderr}Vercel logs: https://vercel.com/okou/vm0-api/logs?search=requestHost%%3Apr-27981-api.vm6.ai+requestPath%%3A%%2Fapi%%2Fruns%%2Frun-1%%2Fcontext+status%%3A%{http_code}&timeline=past12Hours\n'
stall_stderr=$'curl: (28) Operation timed out after 30002 milliseconds with 0 bytes received\nVercel logs: '"$MOCK_CURL_EXPECTED_VERCEL_URL"$'\n'
retry_stderr=$'runner_api_curl retrying https://pr-27981-api.vm6.ai/api/runs/run-1/context after no response (attempt 1 of 2)\n'

MOCK_CURL_MODE=no-response-then-success
reset_curl_attempts
run_request "/api/runs/run-1/context"
assert_status 0
assert_curl_attempts 2
assert_file_equals $'{"ok":true}\n' "$stdout_file"
assert_file_equals "${stall_stderr}${retry_stderr}" "$stderr_file"

MOCK_CURL_MODE=no-response
reset_curl_attempts
run_request "/api/runs/run-1/context"
assert_status 28
assert_curl_attempts 2
assert_file_equals '' "$stdout_file"
assert_file_equals \
    "${stall_stderr}${retry_stderr}${stall_stderr}"$'runner_api_curl failed: url=https://pr-27981-api.vm6.ai/api/runs/run-1/context curl_status=28\nrunner_api_curl received no response from https://pr-27981-api.vm6.ai/api/runs/run-1/context within 30s across 2 attempt(s); the API may have answered after the client gave up: '"${context_vercel_logs_search}"$'&timeline=past12Hours\n' \
    "$stderr_file"
assert_file_excludes "$stderr_file" "$E2E_API_TOKEN"
assert_file_excludes "$stderr_file" "$VERCEL_AUTOMATION_BYPASS_SECRET"

# A write may already have been applied by the API, so it is never repeated.
MOCK_CURL_EXPECTED_URL="https://pr-27981-api.vm6.ai/api/chat/events"
MOCK_CURL_EXPECTED_VERCEL_URL='https://vercel.com/okou/vm0-api/logs?search=requestHost%3Apr-27981-api.vm6.ai+requestPath%3A%2Fapi%2Fchat%2Fevents+status%3A000&timeline=past12Hours'
MOCK_CURL_EXPECTED_VERCEL_WRITE_OUT='%{onerror}%{stderr}Vercel logs: https://vercel.com/okou/vm0-api/logs?search=requestHost%%3Apr-27981-api.vm6.ai+requestPath%%3A%%2Fapi%%2Fchat%%2Fevents+status%%3A%{http_code}&timeline=past12Hours\n'

MOCK_CURL_MODE=no-response
reset_curl_attempts
run_request "/api/chat/events" -X POST -d "$payload"
assert_status 28
assert_curl_attempts 1
assert_file_excludes "$stderr_file" "sensitive-request-payload"

MOCK_CURL_MODE=no-response
reset_curl_attempts
run_request "/api/chat/events" -d "$payload"
assert_status 28
assert_curl_attempts 1

echo "runner_api_curl tests passed"
