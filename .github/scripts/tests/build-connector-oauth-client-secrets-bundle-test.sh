#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDER="${SCRIPT_DIR}/build-connector-oauth-client-secrets-bundle.sh"
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

assert_json_value() {
  local file=$1 key=$2 expected=$3
  local actual
  actual="$(jq -r --arg key "$key" '.[$key] // ""' "$file")"
  if [[ "$actual" != "$expected" ]]; then
    fail "expected ${key} to be ${expected}, got ${actual}"
  fi
}

assert_file_does_not_end_with_newline() {
  local file=$1
  local last_byte
  last_byte="$(tail -c 1 "$file" | od -An -t x1 | tr -d '[:space:]')"
  if [[ "$last_byte" == "0a" ]]; then
    fail "expected ${file} to contain compact JSON without trailing newline"
  fi
}

assert_file_mode() {
  local file=$1 expected=$2
  local actual
  actual="$(stat -c '%a' "$file")"
  if [[ "$actual" != "$expected" ]]; then
    fail "expected ${file} mode ${expected}, got ${actual}"
  fi
}

mkdir -p "${TMPDIR}/bin"
cat > "${TMPDIR}/bin/op" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

item_for_key() {
  local key="$1"
  case "$key" in
    GH_OAUTH_CLIENT_SECRET)
      printf 'github'
      ;;
    *_OAUTH_CLIENT_SECRET)
      local prefix="${key%_OAUTH_CLIENT_SECRET}"
      printf '%s' "$prefix" | tr '[:upper:]_' '[:lower:]-'
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ "$1" == "read" ]]; then
  ref="$2"
  path="${ref#op://}"
  vault="${path%%/*}"
  rest="${path#*/}"
  item="${rest%%/*}"
  key="${rest#*/}"

  expected_item="$(item_for_key "$key")"
  if [[ "$item" != "$expected_item" ]]; then
    echo "expected item ${expected_item} for ${key}, got ${item}" >&2
    exit 1
  fi

  case "${OP_STUB_MODE:-success}:${key}" in
    missing:GOOGLE_OAUTH_CLIENT_SECRET)
      echo "missing field" >&2
      exit 1
      ;;
    empty:GOOGLE_OAUTH_CLIENT_SECRET)
      exit 0
      ;;
    large:GOOGLE_OAUTH_CLIENT_SECRET)
      printf 'x%.0s' {1..50000}
      exit 0
      ;;
  esac

  printf 'secret-%s-%s' "$vault" "$key"
  exit 0
fi

echo "unexpected op invocation: $*" >&2
exit 1
BASH
chmod +x "${TMPDIR}/bin/op"

mkdir -p "${TMPDIR}/no-op-bin"
ln -s "$(command -v bash)" "${TMPDIR}/no-op-bin/bash"

run_builder() {
  local output_file="$1"
  env -i \
    PATH="${TMPDIR}/bin:${PATH}" \
    GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" \
    OP_STUB_MODE="${OP_STUB_MODE:-}" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    VAULT_NAME="${VAULT_NAME:-Development}" \
    OUTPUT_FILE="$output_file" \
    "$BUILDER"
}

success_bundle="${TMPDIR}/bundle.json"
success_output="$(
  GITHUB_ACTIONS=true run_builder "$success_bundle"
)"
assert_contains "$success_output" "Bundled 34 connector OAuth client secret entries from Development"
jq -c -e . "$success_bundle" >/dev/null
if [[ "$(jq 'length' "$success_bundle")" != "34" ]]; then
  fail "expected bundle to contain 34 connector OAuth client secret entries"
fi
assert_json_value "$success_bundle" GH_OAUTH_CLIENT_SECRET secret-Development-GH_OAUTH_CLIENT_SECRET
assert_json_value "$success_bundle" GOOGLE_OAUTH_CLIENT_SECRET secret-Development-GOOGLE_OAUTH_CLIENT_SECRET
assert_json_value "$success_bundle" SLACK_OAUTH_CLIENT_SECRET secret-Development-SLACK_OAUTH_CLIENT_SECRET
assert_json_value "$success_bundle" META_ADS_OAUTH_CLIENT_SECRET secret-Development-META_ADS_OAUTH_CLIENT_SECRET
assert_file_does_not_end_with_newline "$success_bundle"
assert_file_mode "$success_bundle" 600

success_log_output="$(without_mask_commands "$success_output")"
assert_not_contains "$success_log_output" "secret-Development-GOOGLE_OAUTH_CLIENT_SECRET"
assert_not_contains "$success_log_output" "secret-Development-SLACK_OAUTH_CLIENT_SECRET"

production_bundle="${TMPDIR}/production-bundle.json"
production_output="$(
  VAULT_NAME=Production run_builder "$production_bundle"
)"
assert_contains "$production_output" "from Production"
assert_json_value "$production_bundle" GOOGLE_OAUTH_CLIENT_SECRET secret-Production-GOOGLE_OAUTH_CLIENT_SECRET

status=0
missing_op_output="$(
  env -i \
    PATH="${TMPDIR}/no-op-bin" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    VAULT_NAME=Development \
    OUTPUT_FILE="${TMPDIR}/missing-op.json" \
    "$BUILDER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing op case to fail"
fi
assert_contains "$missing_op_output" "1Password CLI (op) is not installed"

status=0
missing_jq_output="$(
  env -i \
    PATH="${TMPDIR}/bin:${TMPDIR}/no-op-bin" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    VAULT_NAME=Development \
    OUTPUT_FILE="${TMPDIR}/missing-jq.json" \
    "$BUILDER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing jq case to fail"
fi
assert_contains "$missing_jq_output" "jq is not installed"

status=0
missing_vault_output="$(
  env -i \
    PATH="${TMPDIR}/bin:${PATH}" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    OUTPUT_FILE="${TMPDIR}/missing-vault.json" \
    "$BUILDER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing VAULT_NAME case to fail"
fi
assert_contains "$missing_vault_output" "VAULT_NAME is required"

status=0
invalid_vault_output="$(
  env -i \
    PATH="${TMPDIR}/bin:${PATH}" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    VAULT_NAME=Preview \
    OUTPUT_FILE="${TMPDIR}/invalid-vault.json" \
    "$BUILDER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected invalid VAULT_NAME case to fail"
fi
assert_contains "$invalid_vault_output" "VAULT_NAME must be Development or Production"

status=0
missing_output_file_output="$(
  env -i \
    PATH="${TMPDIR}/bin:${PATH}" \
    OP_SERVICE_ACCOUNT_TOKEN=test-token \
    VAULT_NAME=Development \
    "$BUILDER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing OUTPUT_FILE case to fail"
fi
assert_contains "$missing_output_file_output" "OUTPUT_FILE is required"

status=0
missing_token_output="$(
  env -i \
    PATH="${TMPDIR}/bin:${PATH}" \
    VAULT_NAME=Development \
    OUTPUT_FILE="${TMPDIR}/missing-token.json" \
    "$BUILDER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing OP_SERVICE_ACCOUNT_TOKEN case to fail"
fi
assert_contains "$missing_token_output" "OP_SERVICE_ACCOUNT_TOKEN is required"

status=0
missing_secret_output="$(
  OP_STUB_MODE=missing run_builder "${TMPDIR}/missing-secret.json" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing 1Password field case to fail"
fi
assert_contains "$missing_secret_output" "GOOGLE_OAUTH_CLIENT_SECRET is missing or unreadable from 1Password"
assert_contains "$missing_secret_output" "connector OAuth client secret value(s) failed validation"

status=0
empty_secret_output="$(
  OP_STUB_MODE=empty run_builder "${TMPDIR}/empty-secret.json" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected empty 1Password field case to fail"
fi
assert_contains "$empty_secret_output" "GOOGLE_OAUTH_CLIENT_SECRET is empty in 1Password"

status=0
large_bundle_output="$(
  OP_STUB_MODE=large run_builder "${TMPDIR}/large-bundle.json" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected oversized bundle case to fail"
fi
assert_contains "$large_bundle_output" "GitHub secret limit is 49152 bytes"

echo "build-connector-oauth-client-secrets-bundle-test: ok"
