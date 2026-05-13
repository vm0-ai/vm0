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
trap 'rm -rf "$tmp"' EXIT

home_success="$tmp/home-success"
make_home "$home_success"
args_file="$tmp/cloudflared.args"
success_cloudflared="$tmp/cloudflared-success"
cat > "$success_cloudflared" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_ARGS_FILE"
exit 0
EOF
chmod +x "$success_cloudflared"

HOME="$home_success" \
CLOUDFLARED_BIN="$success_cloudflared" \
FAKE_ARGS_FILE="$args_file" \
"$PROXY" dev-1.aws.vm3.ai > "$tmp/success.out" 2> "$tmp/success.err"

assert_contains "$args_file" "--hostname dev-1-aws-ssh.vm3.ai"
assert_contains "$args_file" "--id client-id"
assert_contains "$args_file" "--secret super-secret"
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
assert_contains "$summary" "cloudflared exit: \`255\`"
assert_not_contains "$tmp/failure.err" "super-secret"
assert_not_contains "$summary" "super-secret"

echo "cloudflare-ssh-proxy-test: ok"
