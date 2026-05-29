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

{
  printf 'args'
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
  printf 'body\t'
  cat
  printf '\n'
} >> "$GH_STUB_LOG"
BASH
chmod +x "${TMPDIR}/bin/gh"

run_syncer() {
  local log_file=$1
  shift
  GH_STUB_LOG="$log_file" PATH="${TMPDIR}/bin:${PATH}" "$SYNCER" "$@"
}

development_log="${TMPDIR}/development-gh.log"
development_output="$(run_syncer "$development_log" development)"
assert_contains "$development_output" "Building CONNECTOR_OAUTH_CLIENT_SECRETS from the Development 1Password vault"
assert_contains "$development_output" "Updated repository secret CONNECTOR_OAUTH_CLIENT_SECRETS for vm0-ai/vm0"
development_args="$(sed -n '1p' "$development_log")"
assert_contains "$development_args" $'args\tsecret\tset\tCONNECTOR_OAUTH_CLIENT_SECRETS\t--repo\tvm0-ai/vm0'
assert_not_contains "$development_args" $'\t--env\t'
development_body="$(sed -n '2p' "$development_log" | cut -f2-)"
assert_json_value "$development_body" GOOGLE_OAUTH_CLIENT_SECRET secret-Development-GOOGLE_OAUTH_CLIENT_SECRET
assert_json_value "$development_body" GH_OAUTH_CLIENT_SECRET secret-Development-GH_OAUTH_CLIENT_SECRET

production_log="${TMPDIR}/production-gh.log"
production_output="$(run_syncer "$production_log" production vm0-ai/vm0)"
assert_contains "$production_output" "Building CONNECTOR_OAUTH_CLIENT_SECRETS from the Production 1Password vault"
assert_contains "$production_output" "Updated production environment secret CONNECTOR_OAUTH_CLIENT_SECRETS for vm0-ai/vm0"
production_args="$(sed -n '1p' "$production_log")"
assert_contains "$production_args" $'args\tsecret\tset\tCONNECTOR_OAUTH_CLIENT_SECRETS\t--repo\tvm0-ai/vm0\t--env\tproduction'
production_body="$(sed -n '2p' "$production_log" | cut -f2-)"
assert_json_value "$production_body" GOOGLE_OAUTH_CLIENT_SECRET secret-Production-GOOGLE_OAUTH_CLIENT_SECRET

status=0
invalid_scope_output="$(
  GH_STUB_LOG="${TMPDIR}/invalid-gh.log" PATH="${TMPDIR}/bin:${PATH}" "$SYNCER" preview vm0-ai/vm0 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected invalid scope case to fail"
fi
assert_contains "$invalid_scope_output" "Usage:"

echo "sync-connector-oauth-client-secrets-test: ok"
