#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/manage-okou-pages-domain.sh"
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
  */pages/projects/okou-app/domains)
    printf '{"result":[{"name":"pr-22239-app.omby.ai"}]}\n'
    ;;
  */pages/projects/okou-app/domains/pr-22239-app.omby.ai)
    printf '{"result":{"status":"active","verification_data":{"status":"active"}}}\n'
    ;;
  *'/dns_records?type=CNAME&name=pr-22239-app.omby.ai')
    jq -n --arg content "$MOCK_DNS_CONTENT" '{result:[{
      id: "record-id",
      type: "CNAME",
      name: "pr-22239-app.omby.ai",
      content: $content,
      proxied: true,
      ttl: 1
    }]}'
    ;;
  */dns_records/record-id)
    if [[ "$method" != "PUT" ]]; then
      echo "expected a PUT for the existing DNS record" >&2
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

export MOCK_DNS_CONTENT="pr-22239-app.okou-app.pages.dev"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  ensure account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app
if grep -q -- '--request PUT' "$request_log"; then
  echo "expected an already-correct DNS record to skip PUT" >&2
  exit 1
fi

: > "$request_log"
export MOCK_DNS_CONTENT="okou-app.pages.dev"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  ensure account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app
grep -q -- '--request PUT' "$request_log"

echo "manage-okou-pages-domain tests passed"
