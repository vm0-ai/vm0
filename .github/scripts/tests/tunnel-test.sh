#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TUNNEL_SCRIPT="${REPO_ROOT}/scripts/tunnel.sh"
TMPDIR="$(mktemp -d)"
PORT=39991

cleanup() {
  local pid

  pid="$(cat "/tmp/cloudflared-${PORT}.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi

  rm -f "/tmp/cloudflared-${PORT}.pid" "/tmp/cloudflared-${PORT}.log" "/tmp/cloudflared-${PORT}.check"
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "${TMPDIR}/bin" "${TMPDIR}/home/.cloudflared"

cat >"${TMPDIR}/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

args=("$@")
url=""
output_file=""

for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    http*)
      url="${args[$i]}"
      ;;
    -o)
      output_file="${args[$((i + 1))]}"
      ;;
  esac
done

printf '%s\n' "$*" >>"${CURL_LOG:?}"

case "$url" in
  *"/cfd_tunnel?name=test-tunnel"*)
    printf '{"success":true,"result":[{"id":"test-tunnel-id"}]}'
    ;;
  *"/cfd_tunnel/test-tunnel-id/token"*)
    printf '{"success":true,"result":"test-tunnel-token"}'
    ;;
  *"/zones?name=vm7.ai"*)
    printf '{"success":true,"result":[{"id":"test-zone-id"}]}'
    ;;
  *"/dns_records?name=test-tunnel.vm7.ai&type=CNAME"*)
    printf '{"success":true,"result":[]}'
    ;;
  *"/dns_records")
    printf '{"success":true,"result":{"id":"test-record-id"}}'
    ;;
  "https://test-tunnel.vm7.ai/")
    if [[ -n "$output_file" ]]; then
      printf 'ok' >"$output_file"
    fi
    printf '204'
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 2
    ;;
esac
SH
chmod +x "${TMPDIR}/bin/curl"

cat >"${TMPDIR}/bin/cloudflared" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${CLOUDFLARED_LOG:?}"
if [[ "${TUNNEL_TOKEN:-}" == "test-tunnel-token" ]]; then
  printf 'token-env=present\n' >>"${CLOUDFLARED_LOG:?}"
fi

printf 'Registered tunnel connection\n'
sleep 30
SH
chmod +x "${TMPDIR}/bin/cloudflared"

cat >"${TMPDIR}/bin/openssl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf 'test-secret\n'
SH
chmod +x "${TMPDIR}/bin/openssl"

if ! output="$(
  HOME="${TMPDIR}/home" \
    PATH="${TMPDIR}/bin:$PATH" \
    CURL_LOG="${TMPDIR}/curl.log" \
    CLOUDFLARED_LOG="${TMPDIR}/cloudflared.log" \
    CF_DNS_AND_TUNNEL_API_TOKEN=test-api-token \
    CF_ACCOUNT_ID=test-account-id \
    TUNNEL_HOSTNAME=test-tunnel.vm7.ai \
    "$TUNNEL_SCRIPT" "$PORT" 2>"${TMPDIR}/tunnel.err"
)"; then
  cat "${TMPDIR}/tunnel.err" >&2
  fail "expected named tunnel startup to succeed"
fi

[[ "$output" == "https://test-tunnel.vm7.ai" ]] || fail "expected named tunnel URL, got: $output"
grep -q "Using API-fetched tunnel token instead." "${TMPDIR}/tunnel.err" || fail "expected token fallback log"
grep -q "token-env=present" "${TMPDIR}/cloudflared.log" || fail "expected token fallback to start cloudflared"
grep -q -- "--config /tmp/cloudflared-config-test-tunnel.yml --protocol http2 run" "${TMPDIR}/cloudflared.log" || fail "expected cloudflared config run"
if grep -q "test-tunnel-token" "${TMPDIR}/cloudflared.log"; then
  fail "tunnel token should not be passed through cloudflared argv"
fi
grep -q "https://test-tunnel.vm7.ai/" "${TMPDIR}/curl.log" || fail "expected named tunnel readiness check"

echo "tunnel-test: ok"
