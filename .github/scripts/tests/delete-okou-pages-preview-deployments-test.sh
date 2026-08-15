#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/delete-okou-pages-preview-deployments.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/bin"
mock_curl="$tmp_dir/bin/curl"
request_log="$tmp_dir/requests"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'method=GET' \
  'output_file=' \
  'url=' \
  'while (( $# > 0 )); do' \
  '  case "$1" in' \
  '    --request) method="$2"; shift 2 ;;' \
  '    --output) output_file="$2"; shift 2 ;;' \
  '    --retry|--retry-delay|-H) shift 2 ;;' \
  '    --fail-with-body|--silent|--show-error|--retry-all-errors) shift ;;' \
  '    https://*) url="$1"; shift ;;' \
  '    *) echo "unexpected curl argument: $1" >&2; exit 1 ;;' \
  '  esac' \
  'done' \
  'printf "%s\t%s\n" "$method" "$url" >> "$REQUEST_LOG"' \
  'case "$method:$url" in' \
  '  GET:*"page=1"*)' \
  '    printf "%s\n" '\''{"success":true,"result":[{"id":"a1111111-1111-1111-1111-111111111111","environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-42-app"}}},{"id":"b2222222-2222-2222-2222-222222222222","environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-41-app"}}}],"result_info":{"total_pages":2}}'\'' > "$output_file"' \
  '    ;;' \
  '  GET:*"page=2"*)' \
  '    printf "%s\n" '\''{"success":true,"result":[{"id":"c3333333-3333-3333-3333-333333333333","environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-42-app"}}}],"result_info":{"total_pages":2}}'\'' > "$output_file"' \
  '    ;;' \
  '  DELETE:*/deployments/a1111111-1111-1111-1111-111111111111\?force=true)' \
  '    printf "%s\n" '\''{"success":true,"result":null}'\'' > "$output_file"' \
  '    ;;' \
  '  DELETE:*/deployments/c3333333-3333-3333-3333-333333333333\?force=true)' \
  '    printf "%s\n" '\''{"success":true,"result":null}'\'' > "$output_file"' \
  '    ;;' \
  '  *) echo "unexpected request: $method $url" >&2; exit 1 ;;' \
  'esac' > "$mock_curl"
chmod +x "$mock_curl"

export CLOUDFLARE_API_TOKEN="test-token"
export PATH="$tmp_dir/bin:$PATH"
export REQUEST_LOG="$request_log"

output="$tmp_dir/output"
bash "$script" account-id okou-app pr-42-app > "$output"

grep -Fxq 'Found 2 Cloudflare Pages deployment(s) for pr-42-app' "$output"
grep -Fxq 'Deleted 2 Cloudflare Pages deployment(s) for pr-42-app' "$output"
test "$(grep -c '^GET' "$request_log")" -eq 2
test "$(grep -c '^DELETE' "$request_log")" -eq 2
grep -Fq '/deployments/a1111111-1111-1111-1111-111111111111?force=true' "$request_log"
grep -Fq '/deployments/c3333333-3333-3333-3333-333333333333?force=true' "$request_log"
if grep -Fq 'b2222222-2222-2222-2222-222222222222?force=true' "$request_log"; then
  echo "deleted a deployment from another branch" >&2
  exit 1
fi

if bash "$script" account-id okou-app staging-app >/dev/null 2>&1; then
  echo "accepted a non-PR Pages branch" >&2
  exit 1
fi

echo "delete-okou-pages-preview-deployments tests passed"
