#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="${repo_root}/.github/scripts/api-worker-version.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

current_version=00000000-0000-0000-0000-000000000001
candidate_version=00000000-0000-0000-0000-000000000002
target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
method=GET
data=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --request) method=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    -H|--max-time|--retry|--retry-delay) shift 2 ;;
    --fail-with-body|--show-error|--silent|--retry-all-errors) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\t%s\t%s\n' "$method" "$url" "$data" >>"$MOCK_BOUNDARY_LOG"
case "$url" in
  */deployments)
    if [ "$method" = GET ]; then
      jq -n --slurpfile deployments "$MOCK_DEPLOYMENTS_FILE" \
        '{success: true, result: {deployments: $deployments[0]}}'
    else
      jq '.versions' <<<"$data" | jq -n \
        --argjson versions "$(jq '.versions' <<<"$data")" \
        '[{id: "deployment-new", created_on: "2026-08-11T00:00:01Z", versions: $versions}]' \
        >"$MOCK_DEPLOYMENTS_FILE"
      jq -n '{success: true, result: {id: "deployment-new"}}'
    fi
    ;;
  *'/versions?deployable=true')
    jq -n \
      --arg commit "$TARGET_COMMIT" \
      --arg id "$CANDIDATE_VERSION_ID" \
      --argjson count "${MOCK_VERSION_COUNT:-1}" \
      '{
        success: true,
        result: {
          items: [range(0; $count) | {
            id: $id,
            annotations: {"workers/tag": $commit}
          }]
        }
      }'
    ;;
  */versions/*)
    jq -n \
      --arg commit "$TARGET_COMMIT" \
      --argjson cpu_ms "$MOCK_CPU_MS" \
      --arg usage_model "$MOCK_USAGE_MODEL" \
      '{
        success: true,
        result: {
          annotations: {"workers/tag": $commit},
          resources: {
            script_runtime: {
              limits: {cpu_ms: $cpu_ms},
              usage_model: $usage_model
            }
          }
        }
      }'
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 2
    ;;
esac
SH
chmod +x "${fake_bin}/curl"

deployments_file="${tmp_dir}/deployments.json"
boundary_log="${tmp_dir}/boundaries.log"

run_script() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    CANDIDATE_VERSION_ID="$candidate_version" \
    CLOUDFLARE_ACCOUNT_ID=test-account \
    CLOUDFLARE_API_ORIGIN=https://cloudflare.test/client/v4 \
    CLOUDFLARE_API_TOKEN=test-token \
    GITHUB_OUTPUT="$output_file" \
    MOCK_BOUNDARY_LOG="$boundary_log" \
    MOCK_CPU_MS="${MOCK_CPU_MS:-300000}" \
    MOCK_DEPLOYMENTS_FILE="$deployments_file" \
    MOCK_USAGE_MODEL="${MOCK_USAGE_MODEL:-standard}" \
    MOCK_VERSION_COUNT="${MOCK_VERSION_COUNT:-1}" \
    TARGET_COMMIT="$target_commit" \
    TARGET_VERSION_ID="$candidate_version" \
    bash "$script" "$@"
}

jq -n --arg current "$current_version" '[{
  id: "deployment-old",
  created_on: "2026-08-11T00:00:00Z",
  versions: [{version_id: $current, percentage: 100}]
}]' >"$deployments_file"
: >"$boundary_log"
promote_output="${tmp_dir}/promote.output"
run_script "$promote_output" promote
jq -e --arg candidate "$candidate_version" \
  '.[0].versions == [{version_id: $candidate, percentage: 100}]' \
  "$deployments_file" >/dev/null || fail "candidate was not promoted to 100 percent"

resolved=$(run_script "${tmp_dir}/resolve.output" resolve)
[ "$resolved" = "$candidate_version" ] || fail "unexpected resolved version: $resolved"

optional_resolved=$(run_script "${tmp_dir}/resolve-optional.output" resolve-optional)
[ "$optional_resolved" = "$candidate_version" ] || fail "unexpected optional resolved version: $optional_resolved"

runtime_output=$(run_script "${tmp_dir}/runtime.output" verify-runtime)
grep -q 'cpu_ms=300000, usage_model=standard' <<<"$runtime_output" ||
  fail "runtime limits were not verified"

if MOCK_CPU_MS=30000 run_script "${tmp_dir}/runtime-cpu.output" verify-runtime \
  >"${tmp_dir}/runtime-cpu.log" 2>&1; then
  fail "default Worker CPU limit should fail runtime verification"
fi
grep -q 'got 30000' "${tmp_dir}/runtime-cpu.log" || fail "CPU limit failure was not reported"

if MOCK_USAGE_MODEL=bundled run_script "${tmp_dir}/runtime-usage.output" verify-runtime \
  >"${tmp_dir}/runtime-usage.log" 2>&1; then
  fail "non-standard Worker usage model should fail runtime verification"
fi
grep -q 'got bundled' "${tmp_dir}/runtime-usage.log" || fail "usage model failure was not reported"

MOCK_VERSION_COUNT=0
optional_missing=$(run_script "${tmp_dir}/resolve-optional-missing.output" resolve-optional)
unset MOCK_VERSION_COUNT
[ -z "$optional_missing" ] || fail "optional resolution should allow a missing version"

if MOCK_VERSION_COUNT=2 run_script "${tmp_dir}/ambiguous.output" resolve \
  >"${tmp_dir}/ambiguous.log" 2>&1; then
  fail "ambiguous Worker tag should fail"
fi
grep -q 'found 2' "${tmp_dir}/ambiguous.log" || fail "ambiguous failure was not reported"

jq -n '[]' >"$deployments_file"
bootstrap_output="${tmp_dir}/bootstrap.output"
run_script "$bootstrap_output" promote
jq -e --arg candidate "$candidate_version" \
  '.[0].versions == [{version_id: $candidate, percentage: 100}]' \
  "$deployments_file" >/dev/null || fail "first promotion did not deploy the version"

echo "api-worker-version tests passed"
