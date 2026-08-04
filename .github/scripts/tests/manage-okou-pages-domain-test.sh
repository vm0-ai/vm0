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

if [[ "${MOCK_CURL_FAIL_DNS_DELETE:-false}" == "true" ]] &&
  [[ "$url" == */dns_records/record-id ]] &&
  [[ "$method" == "DELETE" ]]; then
  printf '{"success":false,"errors":[{"code":81058,"message":"conflicting dns record"}]}\n'
  exit 22
fi

case "$url" in
  */pages/projects/okou-app/domains)
    if [[ "$method" != "POST" ]]; then
      echo "the paginated Pages domain list must not be used for existence checks" >&2
      exit 1
    fi
    if [[ "${MOCK_PAGES_REQUIRE_DNS_DELETE:-false}" == "true" ]] &&
      ! grep -q -- '--request DELETE' "$MOCK_CURL_LOG"; then
      echo "expected the conflicting DNS record to be deleted before creating the Pages domain" >&2
      exit 1
    fi
    if [[ "${MOCK_PAGES_DUPLICATE_CREATE:-false}" == "true" ]]; then
      printf '{"success":false,"errors":[{"code":8000018,"message":"domain already added"}],"result":null}\n'
    elif [[ "${MOCK_PAGES_CREATE_ERROR:-false}" == "true" ]]; then
      printf '{"success":false,"errors":[{"code":8000042,"message":"domain create failed"}],"result":null}\n'
    else
      printf '{"success":true,"result":{"name":"pr-22239-app.omby.ai","status":"active","verification_data":{"status":"active"}}}\n'
    fi
    ;;
  */pages/projects/okou-app/domains/pr-22239-app.omby.ai)
    if [[ -n "${MOCK_PAGES_MISSING_RESPONSES:-}" ]]; then
      request_count="$(<"$MOCK_PAGES_STATE_FILE")"
      request_count="$((request_count + 1))"
      printf '%s\n' "$request_count" > "$MOCK_PAGES_STATE_FILE"
      if (( request_count <= MOCK_PAGES_MISSING_RESPONSES )); then
        printf '{"success":false,"errors":[{"code":8000021,"message":"domain does not exist"}],"result":null}\n'
      else
        printf '{"success":true,"result":{"status":"active","verification_data":{"status":"active"}}}\n'
      fi
    elif [[ -n "${MOCK_PAGES_PENDING_RESPONSES:-}" ]]; then
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
  *'/dns_records?name=pr-22239-app.omby.ai')
    jq -n \
      --arg content "$MOCK_DNS_CONTENT" \
      --arg type "${MOCK_DNS_TYPE:-CNAME}" \
      '{result:[{
      id: "record-id",
      type: $type,
      name: "pr-22239-app.omby.ai",
      content: $content,
      proxied: true,
      ttl: 1
    }]}'
    ;;
  */dns_records)
    if [[ "$method" != "POST" ]]; then
      echo "expected a POST for the new DNS record" >&2
      exit 1
    fi
    printf '{"success":true}\n'
    ;;
  */dns_records/record-id)
    case "$method" in
      DELETE | PUT) printf '{"success":true}\n' ;;
      *)
        echo "expected a DELETE or PUT for the existing DNS record" >&2
        exit 1
        ;;
    esac
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
export MOCK_DNS_TYPE="A"
export MOCK_DNS_CONTENT="192.0.2.1"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "active"
grep -q -- '--request DELETE' "$request_log"
grep -q -- '--request POST' "$request_log"
unset MOCK_DNS_TYPE

: > "$request_log"
export MOCK_CURL_FAIL_DNS_DELETE="true"
export MOCK_DNS_TYPE="A"
export MOCK_DNS_CONTENT="192.0.2.1"
if output="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app 2>&1)"; then
  echo "expected the DNS delete failure to propagate" >&2
  exit 1
fi
grep -q 'conflicting dns record' <<< "$output"
unset MOCK_CURL_FAIL_DNS_DELETE MOCK_DNS_TYPE

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
export MOCK_PAGES_REQUIRE_DNS_DELETE="true"
export MOCK_DNS_TYPE="A"
export MOCK_DNS_CONTENT="192.0.2.1"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "active"
grep -q -- '--request POST' "$request_log"
test "$(grep -c '/pages/projects/okou-app/domains/pr-22239-app.omby.ai' "$request_log")" = "1"
unset MOCK_PAGES_REQUIRE_DNS_DELETE MOCK_DNS_TYPE

: > "$request_log"
export MOCK_PAGES_DUPLICATE_CREATE="true"
printf '0\n' > "$pages_state_file"
export MOCK_PAGES_MISSING_RESPONSES="3"
export MOCK_PAGES_STATE_FILE="$pages_state_file"
export MOCK_DNS_CONTENT="pr-22239-app.okou-app.pages.dev"
status="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
test "$status" = "pending"
test "$(<"$pages_state_file")" = "1"
grep -q -- '--request POST' "$request_log"
grep -q 'okou-app.pages.dev' "$request_log"
output="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  finish account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app)"
grep -q 'Cloudflare Pages custom branch domain configured' <<< "$output"
test "$(<"$pages_state_file")" = "4"
unset MOCK_PAGES_DUPLICATE_CREATE MOCK_PAGES_MISSING_RESPONSES MOCK_PAGES_STATE_FILE

: > "$request_log"
export MOCK_PAGES_CREATE_ERROR="true"
if output="$(PATH="${tmp_dir}/bin:${PATH}" bash "$script" \
  begin account-id zone-id okou-app pr-22239-app.omby.ai pr-22239-app 2>&1)"; then
  echo "expected a failed Pages domain creation to fail the command" >&2
  exit 1
fi
grep -q 'domain create failed' <<< "$output"
unset MOCK_PAGES_CREATE_ERROR

echo "manage-okou-pages-domain tests passed"
