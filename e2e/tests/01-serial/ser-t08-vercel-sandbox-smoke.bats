#!/usr/bin/env bats

# End-to-end Vercel Sandbox smoke test against a deployed API.
#
# Required env:
#   VERCEL_SANDBOX_SMOKE_API_URL       - deployed API URL
#   CRON_SECRET                        - shared with the deployment
#
# Optional env:
#   VERCEL_AUTOMATION_BYPASS_SECRET    - preview protection bypass

load '../../helpers/setup'

export BATS_TEST_TIMEOUT=120

vercel_sandbox_smoke_api_url() {
    local url="$VERCEL_SANDBOX_SMOKE_API_URL"
    case "$url" in
        http*) printf '%s' "$url" ;;
        *)     printf 'https://%s' "$url" ;;
    esac
}

setup_file() {
    if [[ -z "${VERCEL_SANDBOX_SMOKE_API_URL:-}" ]]; then
        skip "VERCEL_SANDBOX_SMOKE_API_URL not set"
    fi
    if [[ -z "${CRON_SECRET:-}" ]]; then
        skip "CRON_SECRET not set"
    fi
}

@test "vercel sandbox: smoke endpoint creates, runs, and stops sandbox" {
    local base body_file status_code target
    base=$(vercel_sandbox_smoke_api_url)
    body_file="$BATS_TEST_TMPDIR/vercel-sandbox-smoke-response.json"

    local -a headers=(
        -H "Authorization: Bearer $CRON_SECRET"
        -H "Accept: application/json"
    )
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        headers+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi

    target="${base%/}/api/internal/vercel-sandbox/smoke"
    run curl -sS --max-time 90 -o "$body_file" -w "%{http_code}" \
        -X POST \
        "${headers[@]}" \
        "$target"
    if [[ "$status" -ne 0 ]]; then
        echo "# smoke endpoint curl failed with exit $status" >&2
        echo "# curl output: $output" >&2
        if [[ -s "$body_file" ]]; then
            echo "# response body: $(cat "$body_file")" >&2
        fi
        return 1
    fi

    status_code="$output"
    if [[ "$status_code" != "200" ]]; then
        echo "# smoke endpoint returned HTTP $status_code" >&2
        echo "# response body: $(cat "$body_file")" >&2
        return 1
    fi

    if ! jq -e '
      .success == true and
      .sandbox.runtime == "node24" and
      (.sandbox.id | type == "string" and length > 0) and
      .command.cmd == "node" and
      .command.args == ["--version"] and
      .command.exitCode == 0 and
      (.command.stdout | test("^v[0-9]+\\.[0-9]+\\.[0-9]+")) and
      .cleanup.status == "stopped"
    ' "$body_file" >/dev/null; then
        echo "# smoke endpoint returned unexpected success payload" >&2
        echo "# response body: $(cat "$body_file")" >&2
        return 1
    fi
}
