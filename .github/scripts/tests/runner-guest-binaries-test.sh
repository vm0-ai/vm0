#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

RUNNER_GUEST_INVENTORY_PATH="${TMPDIR}/guests.json"
. "${SCRIPT_DIR}/runner-guest-binaries.sh"

cat >"$RUNNER_GUEST_INVENTORY_PATH" <<'JSON'
[
  {
    "package": "guest-one",
    "binary": "guest-one",
    "pathEnv": "GUEST_ONE_PATH",
    "bundledEnv": "BUNDLED_GUEST_ONE",
    "destination": "/usr/local/bin/guest one"
  },
  {
    "package": "guest-two",
    "binary": "guest-two",
    "pathEnv": "GUEST_TWO_PATH",
    "bundledEnv": "BUNDLED_GUEST_TWO",
    "destination": "/sbin/guest-two"
  }
]
JSON

runner_guest_binaries_load

[ "${#RUNNER_GUEST_PACKAGES[@]}" -eq 2 ] || fail "expected two guest packages"
[ "${RUNNER_GUEST_PACKAGES[0]}" = "guest-one" ] || fail "expected first package"
[ "${RUNNER_GUEST_BINARIES[1]}" = "guest-two" ] || fail "expected second binary"
[ "${RUNNER_GUEST_PATH_ENVS[0]}" = "GUEST_ONE_PATH" ] || fail "expected first path env"
[ "${RUNNER_GUEST_BUNDLED_ENVS[1]}" = "BUNDLED_GUEST_TWO" ] || fail "expected second bundled env"
[ "${RUNNER_GUEST_DESTINATIONS[0]}" = "/usr/local/bin/guest one" ] || fail "expected destination with spaces"

printf '[]\n' >"$RUNNER_GUEST_INVENTORY_PATH"
if runner_guest_binaries_load >"${TMPDIR}/empty.out" 2>"${TMPDIR}/empty.err"; then
  fail "expected empty inventory to fail"
fi
grep -q "runner guest inventory must be a non-empty array" "${TMPDIR}/empty.err" || fail "expected empty inventory error"

echo "runner-guest-binaries-test: ok"
