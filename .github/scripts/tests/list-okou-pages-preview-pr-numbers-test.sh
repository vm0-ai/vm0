#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/list-okou-pages-preview-pr-numbers.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/bin"
mock_curl="$tmp_dir/bin/curl"
request_log="$tmp_dir/requests"

# The single-quoted lines intentionally preserve variables for the generated
# curl fake rather than expanding them while this test creates it.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'output_file=' \
  'url=' \
  'while (( $# > 0 )); do' \
  '  case "$1" in' \
  '    --output) output_file="$2"; shift 2 ;;' \
  '    --retry|--retry-delay|-H) shift 2 ;;' \
  '    --fail-with-body|--silent|--show-error|--retry-all-errors) shift ;;' \
  '    https://*) url="$1"; shift ;;' \
  '    *) echo "unexpected curl argument: $1" >&2; exit 1 ;;' \
  '  esac' \
  'done' \
  'printf "%s\n" "$url" >> "$REQUEST_LOG"' \
  'case "$url" in' \
  '  *"page=1"*)' \
  '    printf "%s\n" '\''{"success":true,"result":[{"environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-42-app"}}},{"environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-7-app"}}},{"environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-42-app"}}},{"environment":"production","deployment_trigger":{"metadata":{"branch":"pr-8-app"}}}],"result_info":{"total_pages":2}}'\'' > "$output_file"' \
  '    ;;' \
  '  *"page=2"*)' \
  '    printf "%s\n" '\''{"success":true,"result":[{"environment":"preview","deployment_trigger":{"metadata":{"branch":"staging"}}},{"environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-0-app"}}},{"environment":"preview","deployment_trigger":{"metadata":{"branch":"pr-007-app"}}}],"result_info":{"total_pages":2}}'\'' > "$output_file"' \
  '    ;;' \
  '  *) echo "unexpected request: $url" >&2; exit 1 ;;' \
  'esac' > "$mock_curl"
chmod +x "$mock_curl"

export CLOUDFLARE_API_TOKEN="test-token"
export PATH="$tmp_dir/bin:$PATH"
export REQUEST_LOG="$request_log"

output="$tmp_dir/output"
bash "$script" account-id okou-app > "$output"

printf '7\n42\n' > "$tmp_dir/expected"
diff -u "$tmp_dir/expected" "$output"
test "$(wc -l < "$request_log")" -eq 2

if CLOUDFLARE_API_TOKEN='' bash "$script" account-id okou-app >/dev/null 2>&1; then
  echo "accepted an empty Cloudflare API token" >&2
  exit 1
fi

echo "list-okou-pages-preview-pr-numbers tests passed"
