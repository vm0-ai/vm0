#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="${repo_root}/.github/scripts/reconcile-api-runtime.sh"
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
method=GET
data=
output=
headers_file=
write_out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --request) method=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    --dump-header) headers_file=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    -H|--max-time|--retry|--retry-delay) shift 2 ;;
    --fail-with-body|--show-error|--silent|--retry-all-errors) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\t%s\n' "$method" "$url" >>"$MOCK_BOUNDARY_LOG"

case "$url" in
  *'/dns_records?name=api.vm0.ai')
    proxied=$(cat "$MOCK_DNS_FILE")
    jq -n --argjson proxied "$proxied" '{
      success: true,
      result: [{
        id: "dns-record",
        name: "api.vm0.ai",
        proxiable: true,
        proxied: $proxied,
        type: "CNAME",
        content: "origin.vercel-dns.com"
      }]
    }'
    ;;
  *'/dns_records/dns-record')
    proxied=$(jq -r '.proxied' <<<"$data")
    printf '%s\n' "$proxied" >"$MOCK_DNS_FILE"
    jq -n --argjson proxied "$proxied" \
      '{success: true, result: {id: "dns-record", proxied: $proxied}}'
    ;;
  *'/workers/routes')
    if [ "$method" = GET ]; then
      route=$(cat "$MOCK_ROUTE_FILE")
      jq -n --argjson route "$route" \
        '{success: true, result: (if $route == null then [] else [$route] end)}'
    else
      jq -n \
        --arg pattern "$(jq -r '.pattern' <<<"$data")" \
        --arg script "$(jq -r '.script' <<<"$data")" \
        '{id: "route-id", pattern: $pattern, script: $script}' \
        >"$MOCK_ROUTE_FILE"
      jq -n --argjson route "$(cat "$MOCK_ROUTE_FILE")" \
        '{success: true, result: $route}'
    fi
    ;;
  *'/workers/routes/route-id')
    printf 'null\n' >"$MOCK_ROUTE_FILE"
    jq -n '{success: true, result: {id: "route-id"}}'
    ;;
  'https://api.vm0.ai/api/build-info')
    route=$(cat "$MOCK_ROUTE_FILE")
    if [ "$route" = null ]; then
      runtime=vercel
    else
      runtime=cloudflare-worker
    fi
    if [ -n "$headers_file" ]; then
      printf 'HTTP/2 200\r\nx-vm0-api-runtime: %s\r\n\r\n' "$runtime" >"$headers_file"
    fi
    if [ -n "$output" ]; then
      jq -n --arg commit "$EXPECTED_COMMIT" '{commitSha: $commit}' >"$output"
    fi
    if [ -n "$write_out" ]; then
      printf '200'
    fi
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 2
    ;;
esac
SH
chmod +x "${fake_bin}/curl"

dns_file="${tmp_dir}/dns"
route_file="${tmp_dir}/route.json"
boundary_log="${tmp_dir}/boundaries.log"
target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

run_reconcile() {
  local target=$1
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    CF_API_PUBLIC_HOSTNAME=api.vm0.ai \
    CF_ZONE_ID=test-zone \
    CLOUDFLARE_API_ORIGIN=https://cloudflare.test/client/v4 \
    CLOUDFLARE_API_TOKEN=test-token \
    EXPECTED_COMMIT="$target_commit" \
    MOCK_BOUNDARY_LOG="$boundary_log" \
    MOCK_DNS_FILE="$dns_file" \
    MOCK_ROUTE_FILE="$route_file" \
    TARGET_RUNTIME="$target" \
    bash "$script"
}

printf 'false\n' >"$dns_file"
printf 'null\n' >"$route_file"
: >"$boundary_log"
run_reconcile cloudflare
[ "$(cat "$dns_file")" = true ] || fail "Cloudflare target did not enable proxying"
jq -e '.script == "vm0-api-production" and .pattern == "api.vm0.ai/*"' \
  "$route_file" >/dev/null || fail "Cloudflare target did not create the API route"
proxy_line=$(grep -n $'PATCH\thttps://cloudflare.test/client/v4/zones/test-zone/dns_records/dns-record' "$boundary_log" | cut -d: -f1)
route_line=$(grep -n $'POST\thttps://cloudflare.test/client/v4/zones/test-zone/workers/routes' "$boundary_log" | cut -d: -f1)
[ "$proxy_line" -lt "$route_line" ] || fail "route was created before proxying was enabled"

: >"$boundary_log"
run_reconcile cloudflare
if grep -Eq '^(PATCH|POST|DELETE)' "$boundary_log"; then
  fail "idempotent Cloudflare reconciliation performed a mutation"
fi

: >"$boundary_log"
run_reconcile vercel
[ "$(cat "$dns_file")" = false ] || fail "Vercel target did not disable proxying"
[ "$(cat "$route_file")" = null ] || fail "Vercel target did not remove the Worker route"
delete_line=$(grep -n $'DELETE\thttps://cloudflare.test/client/v4/zones/test-zone/workers/routes/route-id' "$boundary_log" | cut -d: -f1)
unproxy_line=$(grep -n $'PATCH\thttps://cloudflare.test/client/v4/zones/test-zone/dns_records/dns-record' "$boundary_log" | tail -1 | cut -d: -f1)
[ "$delete_line" -lt "$unproxy_line" ] || fail "DNS proxying was disabled before the Worker route was removed"

: >"$boundary_log"
run_reconcile vercel
if grep -Eq '^(PATCH|POST|DELETE)' "$boundary_log"; then
  fail "idempotent Vercel reconciliation performed a mutation"
fi

echo "reconcile-api-runtime tests passed"
