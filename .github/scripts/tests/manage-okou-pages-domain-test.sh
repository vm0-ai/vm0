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
    if [[ "$method" != "POST" ]]; then
      echo "the paginated Pages domain list must not be used for existence checks" >&2
      exit 1
    fi
    printf '{"success":true,"result":{"name":"pr-22239-app.omby.ai"}}\n'
    ;;
  */pages/projects/okou-app/domains/pr-22239-app.omby.ai)
    if [[ -n "${MOCK_PAGES_PENDING_RESPONSES:-}" ]]; then
      request_count="$(<"$MOCK_PAGES_STATE_FILE")"
      request_count="$((request_count + 1))"
      printf '%s\n' "$request_count" > "$MOCK_PAGES_STATE_FILE"
      if (( request_count <= MOCK_PAGES_PENDING_RESPONSES )); then
        printf '{"success":true,"result":{"status":"pending","verification_data":{"status":"pending"}}}\n'
      else
        printf '{"success":true,"result":{"status":"active","verification_data":{"status":"active"}}}\n'
      fi
    elif [[ "${MOCK_PAGES_DOMAIN_EXISTS:-true}" == "false" ]] && \
      ! grep -q -- '--request POST' "$MOCK_CURL_LOG"; then
      printf '{"success":false,"errors":[{"code":8000021,"message":"domain does not exist"}],"result":null}\n'
    else
      printf '{"success":true,"result":{"status":"active","verification_data":{"status":"active"}}}\n'
    fi
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

cat > "${tmp_dir}/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${tmp_dir}/bin/sleep"

export CLOUDFLARE_API_TOKEN="test-token"
export MOCK_CURL_LOG="$request_log"

export MOCK_DNS_CONTENT="pr-22239-app.okou-app.pages.dev"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "active"
if grep -q -- '--request PUT' "$request_log"; then
  echo "expected an already-correct DNS record to skip PUT" >&2
  exit 1
fi

: > "$request_log"
output="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  ensure account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
grep -q 'Cloudflare Pages custom branch domain configured' <<< "$output"

: > "$request_log"
export MOCK_DNS_CONTENT="okou-app.pages.dev"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "active"
grep -q -- '--request PUT' "$request_log"

: > "$request_log"
pages_state_file="${tmp_dir}/pages-state-count"
printf '0\n' > "$pages_state_file"
export MOCK_PAGES_PENDING_RESPONSES="31"
export MOCK_PAGES_STATE_FILE="$pages_state_file"
export MOCK_DNS_CONTENT="okou-app.pages.dev"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "pending"
test "$(<"$pages_state_file")" = "1"
if grep -q 'pr-22239-app.okou-app.pages.dev' "$request_log"; then
  echo "expected pending validation to keep the project Pages target" >&2
  exit 1
fi

: > "$request_log"
PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  finish account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app
test "$(<"$pages_state_file")" = "32"
grep -q -- '--request PUT' "$request_log"
unset MOCK_PAGES_PENDING_RESPONSES MOCK_PAGES_STATE_FILE

: > "$request_log"
export MOCK_PAGES_DOMAIN_EXISTS="false"
export MOCK_DNS_CONTENT="pr-22239-app.okou-app.pages.dev"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "active"
grep -q -- '--request POST' "$request_log"

echo "manage-okou-pages-domain tests passed"
