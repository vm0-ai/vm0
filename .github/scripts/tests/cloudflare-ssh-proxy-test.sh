#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROXY="$REPO_ROOT/.github/scripts/cloudflare-ssh-proxy.sh"

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    echo "--- ${file} ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    echo "expected ${file} not to contain: ${unexpected}" >&2
    echo "--- ${file} ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

make_home() {
  local dir="$1"
  mkdir -p "$dir/.ssh"
  cat > "$dir/.ssh/cf-access.env" <<'EOF'
export CF_ACCESS_CLIENT_ID="client-id"
export CF_ACCESS_CLIENT_SECRET="super-secret"
EOF
}

tmp=$(mktemp -d)
proxy_pid=""

cleanup() {
  if [ -n "$proxy_pid" ]; then
    kill -TERM "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}

trap cleanup EXIT

home_success="$tmp/home-success"
make_home "$home_success"
args_file="$tmp/cloudflared.args"
success_cloudflared="$tmp/cloudflared-success"
cat > "$success_cloudflared" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_ARGS_FILE"
IFS= read -r input
printf 'proxied: %s\n' "$input"
exit 0
EOF
chmod +x "$success_cloudflared"

HOME="$home_success" \
CLOUDFLARED_BIN="$success_cloudflared" \
FAKE_ARGS_FILE="$args_file" \
"$PROXY" dev-1.aws.vm3.ai <<< "SSH-2.0-test-client" > "$tmp/success.out" 2> "$tmp/success.err"

assert_contains "$args_file" "--hostname dev-1-aws-ssh.vm3.ai"
assert_contains "$args_file" "--id client-id"
assert_contains "$args_file" "--secret super-secret"
assert_contains "$tmp/success.out" "proxied: SSH-2.0-test-client"
assert_not_contains "$tmp/success.err" "::error"

home_failure="$tmp/home-failure"
make_home "$home_failure"
summary="$tmp/summary.md"
failure_cloudflared="$tmp/cloudflared-failure"
cat > "$failure_cloudflared" <<'EOF'
#!/usr/bin/env bash
printf 'failed args: %s\n' "$*" >&2
echo "Unable to reach the origin service: context canceled" >&2
exit 255
EOF
chmod +x "$failure_cloudflared"

status=0
HOME="$home_failure" \
CLOUDFLARED_BIN="$failure_cloudflared" \
GITHUB_STEP_SUMMARY="$summary" \
"$PROXY" dev-1.aws.vm3.ai > "$tmp/failure.out" 2> "$tmp/failure.err" || status=$?

if [ "$status" -ne 255 ]; then
  echo "expected failure status 255, got ${status}" >&2
  exit 1
fi

assert_contains "$tmp/failure.err" "::error title=Metal Cloudflare tunnel unavailable::"
assert_contains "$tmp/failure.err" "dev-1.aws.vm3.ai"
assert_contains "$tmp/failure.err" "dev-1-aws-ssh.vm3.ai"
assert_contains "$tmp/failure.err" "----- cloudflared stderr (last 20 lines, redacted) -----"
assert_contains "$summary" "### Metal Cloudflare tunnel unavailable"
assert_contains "$summary" "Exit status: \`255\`"
assert_not_contains "$tmp/failure.err" "super-secret"
assert_not_contains "$tmp/failure.err" "client-id"
assert_not_contains "$summary" "super-secret"
assert_not_contains "$summary" "client-id"

home_hup="$tmp/home-hup"
make_home "$home_hup"
hup_summary="$tmp/hup-summary.md"
hup_logs="$tmp/hup-logs"
hup_pid_file="$tmp/hup.pid"
hup_signal_file="$tmp/hup.signal"
mkdir -p "$hup_logs"
hup_cloudflared="$tmp/cloudflared-hup"
cat > "$hup_cloudflared" <<'EOF'
#!/usr/bin/env bash
trap 'printf "terminated\n" > "$FAKE_SIGNAL_FILE"; exit 143' TERM
printf '%s\n' "$$" > "$FAKE_PID_FILE"
printf 'websocket handshake still pending: %s\n' "$*" >&2
while :; do
  :
done
EOF
chmod +x "$hup_cloudflared"

HOME="$home_hup" \
CLOUDFLARED_BIN="$hup_cloudflared" \
FAKE_PID_FILE="$hup_pid_file" \
FAKE_SIGNAL_FILE="$hup_signal_file" \
GITHUB_STEP_SUMMARY="$hup_summary" \
RUNNER_TEMP="$hup_logs" \
"$PROXY" dev-1.aws.vm3.ai < /dev/null > "$tmp/hup.out" 2> "$tmp/hup.err" &
proxy_pid=$!

deadline=$((SECONDS + 5))
while [ ! -s "$hup_pid_file" ]; do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo "proxy exited before starting cloudflared" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timed out waiting for cloudflared to start" >&2
    exit 1
  fi
done

hup_pid=$(cat "$hup_pid_file")
kill -HUP "$proxy_pid"
status=0
wait "$proxy_pid" || status=$?
proxy_pid=""

if [ "$status" -ne 129 ]; then
  echo "expected HUP status 129, got ${status}" >&2
  exit 1
fi

assert_contains "$hup_signal_file" "terminated"
assert_contains "$tmp/hup.err" "cloudflared stderr before ProxyCommand teardown"
assert_contains "$tmp/hup.err" "websocket handshake still pending"
assert_not_contains "$tmp/hup.err" "::error"
assert_not_contains "$tmp/hup.err" "Cloudflare SSH proxy interrupted"
assert_not_contains "$tmp/hup.err" "super-secret"
assert_not_contains "$tmp/hup.err" "client-id"
if [ -s "$hup_summary" ]; then
  echo "expected HUP not to write a failure summary" >&2
  cat "$hup_summary" >&2
  exit 1
fi
if kill -0 "$hup_pid" 2>/dev/null; then
  echo "expected HUP cloudflared process ${hup_pid} to be reaped" >&2
  exit 1
fi
if compgen -G "$hup_logs/cloudflared-ssh-*.log" > /dev/null; then
  echo "expected HUP cloudflared logs to be removed" >&2
  exit 1
fi

echo "cloudflare-ssh-proxy-test: ok"
