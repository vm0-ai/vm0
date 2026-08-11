#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
vercel_script="${repo_root}/.github/scripts/smoke-api-vercel-deployment.sh"
worker_script="${repo_root}/.github/scripts/smoke-api-worker-version.sh"
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
write_out=
url=
access_id=false
access_secret=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --dump-header) headers_file=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    -H)
      case "$2" in
        'CF-Access-Client-Id: test-client') access_id=true ;;
        'CF-Access-Client-Secret: test-secret') access_secret=true ;;
      esac
      shift 2
      ;;
    --data|--max-time|--retry|--retry-delay|-X) shift 2 ;;
    --fail|--fail-with-body|--show-error|--silent|--retry-all-errors) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\t%s\t%s\n' "$url" "$access_id" "$access_secret" >>"$MOCK_BOUNDARY_LOG"

case "$url" in
  'https://api-deploy.vercel.app/api/build-info')
    printf 'HTTP/2 200\r\nx-vm0-api-runtime: vercel\r\n\r\n' >"$headers_file"
    jq -n --arg commit "$TARGET_COMMIT" '{commitSha: $commit}' >"$output"
    ;;
  'https://api-deploy.vercel.app/health')
    ;;
  'https://api-deploy.vercel.app/api/test/worker-runtime/outbound-safety')
    printf '404'
    ;;
  'https://api-worker-candidate.vm0.ai/api/internal/worker-readiness')
    if [ "$access_id" = true ] && [ "$access_secret" = true ]; then
      printf 'HTTP/2 200\r\nx-vm0-api-runtime: cloudflare-worker\r\n\r\n' >"$headers_file"
      jq -n \
        --arg commit "$TARGET_COMMIT" \
        --arg version "$TARGET_VERSION_ID" \
        '{
          ok: true,
          commitSha: $commit,
          workerVersion: $version,
          checks: {axiom: "ok", database: "ok", kms: "ok", r2: "ok"}
        }' >"$output"
      printf '200'
    else
      printf '403'
    fi
    ;;
  'https://api-worker-candidate.vm0.ai/api/test/worker-runtime/outbound-safety')
    [ "$access_id" = true ] && [ "$access_secret" = true ] || exit 3
    printf '404'
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 2
    ;;
esac
SH
chmod +x "${fake_bin}/curl"

target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
worker_version=11111111-2222-3333-4444-555555555555
boundary_log="${tmp_dir}/boundaries.log"
: >"$boundary_log"

env -i \
  PATH="${fake_bin}:$PATH" \
  HOME="${HOME:-/tmp}" \
  MOCK_BOUNDARY_LOG="$boundary_log" \
  TARGET_COMMIT="$target_commit" \
  VERCEL_DEPLOYMENT_URL=https://api-deploy.vercel.app \
  bash "$vercel_script"

env -i \
  PATH="${fake_bin}:$PATH" \
  HOME="${HOME:-/tmp}" \
  CF_ACCESS_CLIENT_ID=test-client \
  CF_ACCESS_CLIENT_SECRET=test-secret \
  CF_API_PRODUCTION_CANDIDATE_ORIGIN=https://api-worker-candidate.vm0.ai \
  MOCK_BOUNDARY_LOG="$boundary_log" \
  TARGET_COMMIT="$target_commit" \
  TARGET_VERSION_ID="$worker_version" \
  bash "$worker_script"

grep -q $'api/internal/worker-readiness\tfalse\tfalse$' "$boundary_log" ||
  fail "Worker readiness did not verify unauthenticated denial"
grep -q $'api/internal/worker-readiness\ttrue\ttrue$' "$boundary_log" ||
  fail "Worker readiness did not use Cloudflare Access"

echo "production candidate smoke tests passed"
