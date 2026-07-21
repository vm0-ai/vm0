#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/manage-cloudflare-worker-route.sh"
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
while (( $# > 0 )); do
  case "$1" in
    --request)
      method="$2"
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
  */workers/routes)
    if [[ "$method" == "GET" ]]; then
      jq -n \
        --arg script "${MOCK_ROUTE_SCRIPT:-}" \
        --argjson exists "${MOCK_ROUTE_EXISTS:-true}" \
        '{result: (if $exists then [{
          id: "route-id",
          pattern: "pr-123-www.omby.ai/api/*",
          script: $script
        }] else [] end)}'
    elif [[ "$method" == "POST" ]]; then
      printf '{"success":true}\n'
    else
      echo "unexpected routes request: ${method} ${url}" >&2
      exit 1
    fi
    ;;
  */workers/routes/route-id)
    if [[ "$method" != "PUT" && "$method" != "DELETE" ]]; then
      echo "unexpected route request: ${method} ${url}" >&2
      exit 1
    fi
    printf '{"success":true}\n'
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

export MOCK_ROUTE_EXISTS="true"
export MOCK_ROUTE_SCRIPT="vm0-www-pr-123-runtime"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  ensure zone-id 'pr-123-www.omby.ai/api/*' vm0-www-pr-123-runtime
if grep -q -- '--request PUT' "$request_log"; then
  echo "expected an already-correct Worker Route to skip PUT" >&2
  exit 1
fi

: > "$request_log"
export MOCK_ROUTE_SCRIPT="other-worker"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  ensure zone-id 'pr-123-www.omby.ai/api/*' vm0-www-pr-123-runtime
grep -q -- '--request PUT' "$request_log"

: > "$request_log"
export MOCK_ROUTE_EXISTS="false"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  ensure zone-id 'pr-123-www.omby.ai/api/*' vm0-www-pr-123-runtime
grep -q -- '--request POST' "$request_log"

: > "$request_log"
export MOCK_ROUTE_EXISTS="true"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  delete zone-id 'pr-123-www.omby.ai/api/*' vm0-www-pr-123-runtime
grep -q -- '--request DELETE' "$request_log"

echo "manage-cloudflare-worker-route tests passed"
