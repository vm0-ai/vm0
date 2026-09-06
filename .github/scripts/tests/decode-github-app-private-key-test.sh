#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
decoder="$repo_root/.github/scripts/decode-github-app-private-key.sh"
workflow="$repo_root/.github/workflows/publish-presentation-template-archives.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for command in base64 openssl rg; do
  command -v "$command" >/dev/null || fail "$command is required"
done

private_key="$(
  openssl genpkey \
    -algorithm RSA \
    -pkeyopt rsa_keygen_bits:2048 \
    2>/dev/null
)"
encoded_key="$(printf '%s\n' "$private_key" | base64 -w 0)"
escaped_key="$(printf '%s' "$encoded_key" | bash "$decoder")"
round_trip_key="$(printf '%b' "$escaped_key")"

if [[ "$round_trip_key" != "$private_key" ]]; then
  fail "decoded private key did not survive escaped-newline output"
fi

if printf 'not-base64!' | bash "$decoder" >/dev/null 2>&1; then
  fail "invalid Base64 input must fail"
fi

not_a_key="$(printf 'not a private key' | base64 -w 0)"
if printf '%s' "$not_a_key" | bash "$decoder" >/dev/null 2>&1; then
  fail "decoded non-key input must fail"
fi

rg --quiet --fixed-strings \
  'SOURCE_PRIVATE_KEY_BASE64: ${{ secrets.OKOU_GITHUB_APP_PRIVATE_KEY }}' \
  "$workflow" || fail "workflow must read the canonical Base64 private key secret"
rg --quiet --fixed-strings \
  'bash .github/scripts/decode-github-app-private-key.sh' \
  "$workflow" || fail "workflow must decode the private key before token creation"
rg --quiet --fixed-strings \
  'private-key: ${{ steps.source-private-key.outputs.private-key }}' \
  "$workflow" || fail "token action must consume the decoded private key"

if rg --quiet --fixed-strings \
  'private-key: ${{ secrets.OKOU_GITHUB_APP_PRIVATE_KEY }}' \
  "$workflow"; then
  fail "token action must not receive the Base64 secret directly"
fi

echo "decode-github-app-private-key-test: ok"
