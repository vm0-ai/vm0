#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NORMALIZER="${SCRIPT_DIR}/normalize-github-app-private-key.sh"
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

assert_valid_output_key() {
  local output_file=$1
  local key_file=$2

  awk '
    /^private-key<<GITHUB_APP_PRIVATE_KEY$/ { printing = 1; next }
    /^GITHUB_APP_PRIVATE_KEY$/ { printing = 0; next }
    printing { print }
  ' "$output_file" > "$key_file"

  if ! grep -q '^-----BEGIN .*PRIVATE KEY-----$' "$key_file"; then
    fail "expected normalized private key output to contain a PEM header"
  fi

  if ! grep -q '^-----END .*PRIVATE KEY-----$' "$key_file"; then
    fail "expected normalized private key output to contain a PEM footer"
  fi

  openssl pkey -in "$key_file" -noout >/dev/null 2>&1 ||
    fail "expected normalized private key output to be parseable by OpenSSL"
}

run_normalizer() {
  local private_key=$1
  local output_file=$2

  env -i \
    PATH="$PATH" \
    VM0_GITHUB_APP_PRIVATE_KEY="$private_key" \
    GITHUB_OUTPUT="$output_file" \
    "$NORMALIZER"
}

private_key_file="${TMPDIR}/private-key.pem"
openssl genrsa -traditional -out "$private_key_file" 2048 2>/dev/null
private_key="$(cat "$private_key_file")"

raw_output="${TMPDIR}/raw-output"
run_normalizer "$private_key" "$raw_output"
assert_valid_output_key "$raw_output" "${TMPDIR}/raw-key.pem"

escaped_private_key="${private_key//$'\n'/\\n}"
escaped_output="${TMPDIR}/escaped-output"
run_normalizer "$escaped_private_key" "$escaped_output"
assert_valid_output_key "$escaped_output" "${TMPDIR}/escaped-key.pem"

base64_private_key="$(base64 -w 0 "$private_key_file")"
base64_output="${TMPDIR}/base64-output"
run_normalizer "$base64_private_key" "$base64_output"
assert_valid_output_key "$base64_output" "${TMPDIR}/base64-key.pem"

collapsed_private_key="$(tr '\n' ' ' < "$private_key_file")"
collapsed_output="${TMPDIR}/collapsed-output"
run_normalizer "$collapsed_private_key" "$collapsed_output"
assert_valid_output_key "$collapsed_output" "${TMPDIR}/collapsed-key.pem"

compact_private_key="$(tr -d '\n' < "$private_key_file")"
compact_output="${TMPDIR}/compact-output"
run_normalizer "$compact_private_key" "$compact_output"
assert_valid_output_key "$compact_output" "${TMPDIR}/compact-key.pem"

status=0
missing_secret_output="$(
  env -i \
    PATH="$PATH" \
    GITHUB_OUTPUT="${TMPDIR}/missing-secret-output" \
    "$NORMALIZER" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing VM0_GITHUB_APP_PRIVATE_KEY case to fail"
fi
assert_contains "$missing_secret_output" "VM0_GITHUB_APP_PRIVATE_KEY is required"

status=0
invalid_secret_output="$(
  run_normalizer "not a private key" "${TMPDIR}/invalid-output" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected invalid private key case to fail"
fi
assert_contains "$invalid_secret_output" "must be PEM or base64-encoded PEM"

status=0
invalid_pem_output="$(
  run_normalizer \
    "-----BEGIN RSA PRIVATE KEY-----not-a-valid-key-----END RSA PRIVATE KEY-----" \
    "${TMPDIR}/invalid-pem-output" 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected invalid PEM private key case to fail"
fi
assert_contains "$invalid_pem_output" "is not a valid PEM private key"

echo "normalize-github-app-private-key-test: ok"
