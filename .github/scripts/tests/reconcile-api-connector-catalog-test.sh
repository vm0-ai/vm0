#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/reconcile-api-connector-catalog.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
fake_bin="${test_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$MOCK_CURL_ARGS"
attempt=1
if [ -f "$MOCK_CURL_COUNT" ]; then
  attempt=$(( $(cat "$MOCK_CURL_COUNT") + 1 ))
fi
printf '%s\n' "$attempt" >"$MOCK_CURL_COUNT"
response=$(sed -n "${attempt}p" "$MOCK_CURL_RESPONSES")
if [ -z "$response" ]; then
  response=$(tail -n 1 "$MOCK_CURL_RESPONSES")
fi
if [ "$response" = "__HTTP_FAILURE__" ]; then
  echo "curl: mock HTTP failure" >&2
  exit 22
fi
printf '%s\n' "$response"
SH

cat >"${fake_bin}/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_SLEEP_ARGS"
SH

chmod +x "${fake_bin}/curl" "${fake_bin}/sleep"

ready_response='{"outcome":"unchanged","state":"current","active":{"catalogVersion":"sensitive-version","catalogDigest":"sha256:sensitive-digest"},"filtering":{"capabilityDigest":"sha256:sensitive-capability","stale":false,"filteredAuthMethods":[{"connectorSlug":"sensitive-connector"}]},"runtimeProjection":{"state":"ready"}}'
legacy_response='{"outcome":"unchanged","state":"current","active":{"catalogVersion":"legacy-version"},"filtering":{"stale":false,"filteredAuthMethods":[]}}'
not_ready_response='{"outcome":"unchanged","state":"current","active":{"catalogVersion":"sensitive-version"},"filtering":{"stale":false,"filteredAuthMethods":[]},"runtimeProjection":{"state":"not-ready","reason":"incomplete"}}'

run_case() {
  local name=$1
  local mode=$2
  local responses=$3
  local bypass_secret=${4-sensitive-bypass-secret}
  local case_dir="${test_dir}/${name}"
  mkdir -p "$case_dir"
  printf '%s\n' "$responses" >"${case_dir}/responses"
  : >"${case_dir}/curl-args"
  : >"${case_dir}/sleep-args"
  env \
    PATH="${fake_bin}:$PATH" \
    CRON_SECRET="sensitive-cron-secret" \
    MOCK_CURL_ARGS="${case_dir}/curl-args" \
    MOCK_CURL_COUNT="${case_dir}/curl-count" \
    MOCK_CURL_RESPONSES="${case_dir}/responses" \
    MOCK_SLEEP_ARGS="${case_dir}/sleep-args" \
    VERCEL_AUTOMATION_BYPASS_SECRET="$bypass_secret" \
    bash "$script" "https://api-preview.example.test/" "$mode"
}

strict_output=$(run_case strict-ready strict "$ready_response")
grep -q 'catalogCurrent.*true' <<<"$strict_output" || fail "strict success did not log current state"
grep -q 'runtimeProjection.*ready' <<<"$strict_output" || fail "strict success did not log ready state"
grep -q -- '-H Authorization: Bearer sensitive-cron-secret' "${test_dir}/strict-ready/curl-args" || fail "cron authorization header missing"
grep -q -- '-H x-vercel-protection-bypass: sensitive-bypass-secret' "${test_dir}/strict-ready/curl-args" || fail "Vercel bypass header missing"
grep -q 'https://api-preview.example.test/api/cron/sync-connector-catalog' "${test_dir}/strict-ready/curl-args" || fail "exact deployment URL missing"

run_case no-bypass strict "$ready_response" "" >/dev/null
if grep -q 'x-vercel-protection-bypass' "${test_dir}/no-bypass/curl-args"; then
  fail "empty Vercel bypass secret added a header"
fi

if run_case strict-missing strict "$legacy_response" >"${test_dir}/strict-missing.out" 2>&1; then
  fail "strict mode accepted a missing runtime projection field"
fi
[ "$(wc -l <"${test_dir}/strict-missing/sleep-args")" -eq 2 ] || fail "strict exhaustion did not sleep twice"

legacy_output=$(run_case legacy-success allow-legacy "$legacy_response")
grep -q 'runtimeProjection.*legacy-response' <<<"$legacy_output" || fail "legacy success was not identified"

if run_case legacy-not-ready allow-legacy "$not_ready_response" >"${test_dir}/legacy-not-ready.out" 2>&1; then
  fail "legacy mode accepted an explicit non-ready response"
fi
grep -q 'runtimeProjection.*incomplete' "${test_dir}/legacy-not-ready.out" || fail "bounded non-ready reason was not logged"

recovery_responses=$(printf '%s\n%s\n%s' '__HTTP_FAILURE__' 'not-json' "$ready_response")
recovery_output=$(run_case recovery strict "$recovery_responses" 2>&1)
grep -q 'attempt 1/3' <<<"$recovery_output" || fail "HTTP retry was not reported"
grep -q 'attempt 2/3' <<<"$recovery_output" || fail "invalid JSON retry was not reported"
[ "$(cat "${test_dir}/recovery/curl-count")" -eq 3 ] || fail "recovery did not use three attempts"

for sensitive in \
  sensitive-cron-secret \
  sensitive-bypass-secret \
  sensitive-version \
  sensitive-digest \
  sensitive-capability \
  sensitive-connector; do
  if grep -q "$sensitive" <<<"$recovery_output"; then
    fail "reconcile logs leaked $sensitive"
  fi
done

if run_case invalid-mode unsupported "$ready_response" >"${test_dir}/invalid-mode.out" 2>&1; then
  fail "invalid response mode succeeded"
fi
[ ! -s "${test_dir}/invalid-mode/curl-args" ] || fail "invalid mode called curl"

echo "reconcile-api-connector-catalog tests passed"
