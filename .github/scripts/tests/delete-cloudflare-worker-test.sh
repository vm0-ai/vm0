#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/delete-cloudflare-worker.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "${tmp_dir}/bin"
request_log="${tmp_dir}/requests.log"

cat > "${tmp_dir}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >> "$MOCK_CURL_LOG"
printf '\n' >> "$MOCK_CURL_LOG"

url=""
method="GET"
output_file=""
while (( $# > 0 )); do
  case "$1" in
    --request)
      method="$2"
      shift 2
      ;;
    --output)
      output_file="$2"
      shift 2
      ;;
    --write-out)
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

case "$url" in
  */workers/scripts/vm0-www-pr-123-runtime)
    if [[ "$method" != "DELETE" ]]; then
      echo "unexpected Worker request: ${method} ${url}" >&2
      exit 1
    fi
    if [[ "${MOCK_WORKER_EXISTS:-true}" == "true" ]]; then
      printf '{"success":true}\n' > "$output_file"
      printf '200'
    else
      printf '{"success":false,"errors":[{"code":10007,"message":"not found"}]}\n' > "$output_file"
      printf '404'
    fi
    ;;
  *)
    echo "unexpected Cloudflare request: ${method} ${url}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/bin/curl"

export CLOUDFLARE_API_TOKEN="test-token"
export MOCK_CURL_LOG="$request_log"

export MOCK_WORKER_EXISTS="true"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  account-id vm0-www-pr-123-runtime
test "$(grep -c -- '--request DELETE' "$request_log")" = "1"

: > "$request_log"
export MOCK_WORKER_EXISTS="false"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  account-id vm0-www-pr-123-runtime
test "$(grep -c -- '--request DELETE' "$request_log")" = "1"

echo "delete-cloudflare-worker tests passed"
