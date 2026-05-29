#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYNCER="${REPO_ROOT}/scripts/sync-connector-oauth-client-secrets.sh"
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

assert_json_value() {
  local json=$1 key=$2 expected=$3
  local actual
  actual="$(jq -r --arg key "$key" '.[$key] // ""' <<< "$json")"
  if [[ "$actual" != "$expected" ]]; then
    fail "expected ${key} to be ${expected}, got ${actual}"
  fi
}

assert_json_is_compact() {
  local json=$1
  if [[ "$json" == *$'\n'* ]]; then
    fail "expected bundle JSON to be compact without embedded newlines"
  fi
}

assert_file_has_no_lf() {
  local file=$1
  local lf_count
  lf_count="$(tr -cd '\n' < "$file" | wc -c | tr -d '[:space:]')"
  if [[ "$lf_count" != "0" ]]; then
    fail "expected bundle JSON written to gh stdin to contain no LF bytes"
  fi
}

mkdir -p "${TMPDIR}/bin"
mkdir -p "${TMPDIR}/no-op-bin"
ln -s "$(command -v bash)" "${TMPDIR}/no-op-bin/bash"

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

if [[ "$1" == "vault" && "$2" == "get" ]]; then
  case "$3" in
    Development | Production)
      exit 0
      ;;
    *)
      exit 1
      ;;
  esac
fi

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

cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" != "secret" || "$2" != "set" ]]; then
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi

body_file="${GH_STUB_LOG}.body"
cat > "$body_file"

{
  printf 'args'
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
  printf 'body\t'
  cat "$body_file"
  printf '\n'
} >> "$GH_STUB_LOG"
BASH
chmod +x "${TMPDIR}/bin/gh"

mkdir -p "${TMPDIR}/missing-jq-bin"
ln -s "$(command -v bash)" "${TMPDIR}/missing-jq-bin/bash"
ln -s "${TMPDIR}/bin/op" "${TMPDIR}/missing-jq-bin/op"
ln -s "${TMPDIR}/bin/gh" "${TMPDIR}/missing-jq-bin/gh"

mkdir -p "${TMPDIR}/missing-gh-bin"
ln -s "$(command -v bash)" "${TMPDIR}/missing-gh-bin/bash"
ln -s "$(command -v jq)" "${TMPDIR}/missing-gh-bin/jq"
ln -s "${TMPDIR}/bin/op" "${TMPDIR}/missing-gh-bin/op"

run_syncer() {
  local log_file=$1
  shift
  GH_STUB_LOG="$log_file" OP_STUB_MODE="${OP_STUB_MODE:-}" PATH="${TMPDIR}/bin:${PATH}" "$SYNCER" "$@"
}

development_log="${TMPDIR}/development-gh.log"
development_output="$(run_syncer "$development_log" development)"
assert_contains "$development_output" "Building CONNECTOR_OAUTH_CLIENT_SECRETS from the Development 1Password vault"
assert_contains "$development_output" "Updated repository secret CONNECTOR_OAUTH_CLIENT_SECRETS for vm0-ai/vm0"
development_args="$(sed -n '1p' "$development_log")"
assert_contains "$development_args" $'args\tsecret\tset\tCONNECTOR_OAUTH_CLIENT_SECRETS\t--repo\tvm0-ai/vm0'
assert_not_contains "$development_args" $'\t--env\t'
development_body="$(sed -n '2p' "$development_log" | cut -f2-)"
assert_json_is_compact "$development_body"
assert_file_has_no_lf "${development_log}.body"
assert_json_value "$development_body" GOOGLE_OAUTH_CLIENT_SECRET secret-Development-GOOGLE_OAUTH_CLIENT_SECRET
assert_json_value "$development_body" GH_OAUTH_CLIENT_SECRET secret-Development-GH_OAUTH_CLIENT_SECRET
if [[ "$(jq 'length' <<< "$development_body")" != "34" ]]; then
  fail "expected development bundle to contain 34 connector OAuth client secret entries"
fi

production_log="${TMPDIR}/production-gh.log"
production_output="$(run_syncer "$production_log" production vm0-ai/vm0)"
assert_contains "$production_output" "Building CONNECTOR_OAUTH_CLIENT_SECRETS from the Production 1Password vault"
assert_contains "$production_output" "Updated production environment secret CONNECTOR_OAUTH_CLIENT_SECRETS for vm0-ai/vm0"
production_args="$(sed -n '1p' "$production_log")"
assert_contains "$production_args" $'args\tsecret\tset\tCONNECTOR_OAUTH_CLIENT_SECRETS\t--repo\tvm0-ai/vm0\t--env\tproduction'
production_body="$(sed -n '2p' "$production_log" | cut -f2-)"
assert_file_has_no_lf "${production_log}.body"
assert_json_value "$production_body" GOOGLE_OAUTH_CLIENT_SECRET secret-Production-GOOGLE_OAUTH_CLIENT_SECRET

status=0
missing_secret_log="${TMPDIR}/missing-secret-gh.log"
missing_secret_output="$(
  OP_STUB_MODE=missing run_syncer "$missing_secret_log" development 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing 1Password field case to fail"
fi
assert_contains "$missing_secret_output" "GOOGLE_OAUTH_CLIENT_SECRET is missing or unreadable from 1Password"
assert_contains "$missing_secret_output" "connector OAuth client secret value(s) failed validation"
if [[ -s "$missing_secret_log" ]]; then
  fail "expected missing 1Password field case not to call gh"
fi

status=0
empty_secret_log="${TMPDIR}/empty-secret-gh.log"
empty_secret_output="$(
  OP_STUB_MODE=empty run_syncer "$empty_secret_log" development 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected empty 1Password field case to fail"
fi
assert_contains "$empty_secret_output" "GOOGLE_OAUTH_CLIENT_SECRET is empty in 1Password"
if [[ -s "$empty_secret_log" ]]; then
  fail "expected empty 1Password field case not to call gh"
fi

status=0
large_bundle_log="${TMPDIR}/large-bundle-gh.log"
large_bundle_output="$(
  OP_STUB_MODE=large run_syncer "$large_bundle_log" development 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected oversized bundle case to fail"
fi
assert_contains "$large_bundle_output" "GitHub secret limit is 49152 bytes"
if [[ -s "$large_bundle_log" ]]; then
  fail "expected oversized bundle case not to call gh"
fi

status=0
missing_op_output="$(
  GH_STUB_LOG="${TMPDIR}/missing-op-gh.log" PATH="${TMPDIR}/no-op-bin" "$SYNCER" development 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing op case to fail"
fi
assert_contains "$missing_op_output" "1Password CLI (op) is not installed"

status=0
missing_jq_output="$(
  GH_STUB_LOG="${TMPDIR}/missing-jq-gh.log" PATH="${TMPDIR}/missing-jq-bin" "$SYNCER" development 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing jq case to fail"
fi
assert_contains "$missing_jq_output" "jq is not installed"

status=0
missing_gh_output="$(
  GH_STUB_LOG="${TMPDIR}/missing-gh.log" PATH="${TMPDIR}/missing-gh-bin" "$SYNCER" development 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing gh case to fail"
fi
assert_contains "$missing_gh_output" "GitHub CLI (gh) is not installed"

status=0
invalid_scope_output="$(
  GH_STUB_LOG="${TMPDIR}/invalid-gh.log" PATH="${TMPDIR}/bin:${PATH}" "$SYNCER" preview vm0-ai/vm0 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected invalid scope case to fail"
fi
assert_contains "$invalid_scope_output" "Usage:"

echo "sync-connector-oauth-client-secrets-test: ok"
