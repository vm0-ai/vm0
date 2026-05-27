#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="${SCRIPT_DIR}/verify-1password-secrets.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected output to contain: ${expected}"
  fi
}

assert_not_contains() {
  local output=$1 unexpected=$2
  if [[ "$output" == *"$unexpected"* ]]; then
    fail "expected output not to contain: ${unexpected}"
  fi
}

without_mask_commands() {
  grep -v '^::add-mask::' <<< "$1" || true
}

mkdir -p "${TMPDIR}/bin"
cat > "${TMPDIR}/bin/op" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "vault list" ]]; then
  case "${OP_STUB_VAULTS:-development}" in
    both)
      printf '[{"name":"Development"},{"name":"Production"}]\n'
      ;;
    empty)
      printf '[]\n'
      ;;
    *)
      printf '[{"name":"Development"}]\n'
      ;;
  esac
  exit 0
fi

if [[ "$1" == "read" ]]; then
  case "$2" in
    op://Development/google/GOOGLE_OAUTH_CLIENT_SECRET)
      printf 'shared-google-secret'
      ;;
    op://Development/slack/SLACK_CLIENT_SECRET)
      printf 'shared-slack-secret'
      ;;
    op://Development/github/GH_OAUTH_CLIENT_SECRET)
      printf 'op-github-secret'
      ;;
    *)
      echo "op-error-secret" >&2
      exit 1
      ;;
  esac
  exit 0
fi

echo "unexpected op invocation: $*" >&2
exit 1
BASH
chmod +x "${TMPDIR}/bin/op"

run_verifier() {
  env -i \
    PATH="${TMPDIR}/bin:${PATH}" \
    GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" \
    OP_STUB_VAULTS="${OP_STUB_VAULTS:-}" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    VAULT_NAME=Development \
    EXPECTED_FORBIDDEN_VAULT=Production \
    EXPECTED_KEYS="${EXPECTED_KEYS:-}" \
    GH_OAUTH_CLIENT_SECRET="${GH_OAUTH_CLIENT_SECRET:-}" \
    GOOGLE_OAUTH_CLIENT_SECRET="${GOOGLE_OAUTH_CLIENT_SECRET:-}" \
    SLACK_CLIENT_SECRET="${SLACK_CLIENT_SECRET:-}" \
    "$VERIFY"
}

success_output="$(
  EXPECTED_KEYS=$'GOOGLE_OAUTH_CLIENT_SECRET\nSLACK_CLIENT_SECRET' \
    GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    SLACK_CLIENT_SECRET=shared-slack-secret \
    run_verifier
)"
assert_contains "$success_output" "ok: GOOGLE_OAUTH_CLIENT_SECRET"
assert_contains "$success_output" "ok: SLACK_CLIENT_SECRET"
assert_contains "$success_output" "Checked 2 Development secrets"
success_log_output="$(without_mask_commands "$success_output")"
assert_not_contains "$success_log_output" "shared-google-secret"
assert_not_contains "$success_log_output" "shared-slack-secret"

status=0
mixed_output="$(
  EXPECTED_KEYS=$'GOOGLE_OAUTH_CLIENT_SECRET\nSLACK_CLIENT_SECRET\nX_OAUTH_CLIENT_SECRET\nGH_OAUTH_CLIENT_SECRET' \
    GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    SLACK_CLIENT_SECRET=shared-slack-secret \
    GH_OAUTH_CLIENT_SECRET=github-github-secret \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected mixed verifier case to fail"
fi
assert_contains "$mixed_output" "ok: GOOGLE_OAUTH_CLIENT_SECRET"
assert_contains "$mixed_output" "ok: SLACK_CLIENT_SECRET"
assert_contains "$mixed_output" "X_OAUTH_CLIENT_SECRET is missing from GitHub secrets"
assert_contains "$mixed_output" "X_OAUTH_CLIENT_SECRET is missing or unreadable from 1Password"
assert_contains "$mixed_output" "GH_OAUTH_CLIENT_SECRET differs between GitHub secrets and 1Password"
assert_contains "$mixed_output" "3 secret comparison(s) failed"
mixed_log_output="$(without_mask_commands "$mixed_output")"
assert_not_contains "$mixed_log_output" "github-github-secret"
assert_not_contains "$mixed_log_output" "op-github-secret"
assert_not_contains "$mixed_log_output" "op-error-secret"

status=0
empty_output="$(
  OP_STUB_VAULTS=empty \
    EXPECTED_KEYS=GOOGLE_OAUTH_CLIENT_SECRET \
    GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected empty vault case to fail"
fi
assert_contains "$empty_output" "visible vault count: 0"
assert_not_contains "$empty_output" "Visible vaults"

status=0
forbidden_output="$(
  OP_STUB_VAULTS=both \
    EXPECTED_KEYS=GOOGLE_OAUTH_CLIENT_SECRET \
    GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected forbidden vault case to fail"
fi
assert_contains "$forbidden_output" "unexpectedly has access to Production vault"
assert_not_contains "$forbidden_output" "Visible vaults"

echo "verify-1password-secrets-test: ok"
