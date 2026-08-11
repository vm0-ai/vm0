#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="${repo_root}/.github/scripts/verify-api-production-pair.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=
headers_file=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --dump-header) headers_file=$2; shift 2 ;;
    --request|-H|--max-time|--retry|--retry-delay) shift 2 ;;
    --fail|--fail-with-body|--show-error|--silent|--retry-all-errors) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  *'/v13/deployments/api.vm0.ai?teamId=test-team')
    jq -n --arg commit "$VERCEL_COMMIT" '{
      projectId: "test-project",
      target: "production",
      readyState: "READY",
      url: "api-deploy.vercel.app",
      meta: {githubCommitSha: $commit}
    }'
    ;;
  *'/workers/scripts/vm0-api-production/deployments')
    jq -n '{success: true, result: {deployments: [{
      id: "deployment",
      created_on: "2026-08-11T00:00:00Z",
      versions: [{
        version_id: "11111111-2222-3333-4444-555555555555",
        percentage: 100
      }]
    }]}}'
    ;;
  *'/workers/scripts/vm0-api-production/versions/11111111-2222-3333-4444-555555555555')
    jq -n --arg commit "$WORKER_COMMIT" \
      '{success: true, result: {annotations: {"workers/tag": $commit}}}'
    ;;
  'https://api-deploy.vercel.app/api/build-info')
    printf 'HTTP/2 200\r\nx-vm0-api-runtime: vercel\r\n\r\n' >"$headers_file"
    jq -n --arg commit "$VERCEL_COMMIT" '{commitSha: $commit}' >"$output"
    ;;
  'https://api-worker-candidate.vm0.ai/api/build-info')
    printf 'HTTP/2 200\r\nx-vm0-api-runtime: cloudflare-worker\r\n\r\n' >"$headers_file"
    jq -n --arg commit "$CANDIDATE_COMMIT" '{commitSha: $commit}' >"$output"
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 2
    ;;
esac
SH
chmod +x "${fake_bin}/curl"

target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

run_verify() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    CF_ACCESS_CLIENT_ID=test-client \
    CF_ACCESS_CLIENT_SECRET=test-secret \
    CF_API_PRODUCTION_CANDIDATE_ORIGIN=https://api-worker-candidate.vm0.ai \
    CANDIDATE_COMMIT="${CANDIDATE_COMMIT:-$target_commit}" \
    CLOUDFLARE_ACCOUNT_ID=test-account \
    CLOUDFLARE_API_ORIGIN=https://cloudflare.test/client/v4 \
    CLOUDFLARE_API_TOKEN=test-cloudflare-token \
    EXPECTED_COMMIT="$target_commit" \
    GITHUB_OUTPUT="$output_file" \
    VERCEL_API_ORIGIN=https://vercel.test \
    VERCEL_COMMIT="${VERCEL_COMMIT:-$target_commit}" \
    VERCEL_ORG_ID=test-team \
    VERCEL_PROJECT_ID=test-project \
    VERCEL_TOKEN=test-vercel-token \
    WORKER_COMMIT="${WORKER_COMMIT:-$target_commit}" \
    bash "$script" "$@"
}

output_file="${tmp_dir}/success.output"
run_verify "$output_file"
grep -qx "target_commit=${target_commit}" "$output_file" || fail "missing target commit output"
grep -qx 'vercel_deployment_url=https://api-deploy.vercel.app' "$output_file" || fail "missing Vercel URL output"
grep -qx 'worker_version_id=11111111-2222-3333-4444-555555555555' "$output_file" || fail "missing Worker version output"

if WORKER_COMMIT=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  run_verify "${tmp_dir}/mismatch.output" >"${tmp_dir}/mismatch.log" 2>&1; then
  fail "mismatched runtime commits should fail"
fi
grep -q 'production runtimes differ' "${tmp_dir}/mismatch.log" || fail "commit mismatch was not reported"

if CANDIDATE_COMMIT=cccccccccccccccccccccccccccccccccccccccc \
  run_verify "${tmp_dir}/candidate-mismatch.output" >"${tmp_dir}/candidate-mismatch.log" 2>&1; then
  fail "mismatched isolated candidate commit should fail"
fi
grep -q 'Worker production deployment build-info does not match' \
  "${tmp_dir}/candidate-mismatch.log" || fail "candidate commit mismatch was not reported"

echo "verify-api-production-pair tests passed"
