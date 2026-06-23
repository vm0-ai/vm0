#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_GROUPS="${SCRIPT_DIR}/runner-host-architecture-groups.sh"
TARGET="${SCRIPT_DIR}/runner-image-target.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run_clean() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@"
}

assert_json_eq() {
  local actual=$1 expected=$2
  local actual_canonical expected_canonical
  actual_canonical=$(jq -cS . <<<"$actual")
  expected_canonical=$(jq -cS . <<<"$expected")
  [ "$actual_canonical" = "$expected_canonical" ] || fail "expected ${expected_canonical}, got ${actual_canonical}"
}

assert_compact_json() {
  local output=$1
  jq -e 'type == "array"' >/dev/null <<<"$output" || fail "expected JSON array: ${output}"
  if [[ "$output" == *$'\n'* ]]; then
    fail "expected compact single-line JSON: ${output}"
  fi
}

assert_no_hosts_field() {
  local output=$1
  jq -e 'all(.[]; has("hosts") | not)' >/dev/null <<<"$output" || fail "expected no hosts field: ${output}"
}

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","hosts":"arm-1,arm-2","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_no_hosts_field "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS" has-groups)
[ "$out" = "true" ] || fail "expected ARM64 has-groups=true, got: ${out}"

out=$(run_clean X86_64_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"x86_64","label":"x86_64","hosts":"x86-1","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean X86_64_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_no_hosts_field "$out"
assert_json_eq "$out" '[{"id":"x86_64","label":"x86_64","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean X86_64_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS" has-groups)
[ "$out" = "true" ] || fail "expected x86_64 has-groups=true, got: ${out}"

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1' X86_64_METAL_RUNNER_HOSTS='x86-1,x86-2' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","hosts":"arm-1","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"},{"id":"x86_64","label":"x86_64","hosts":"x86-1,x86-2","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1' X86_64_METAL_RUNNER_HOSTS='x86-1,x86-2' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_no_hosts_field "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"},{"id":"x86_64","label":"x86_64","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS=' arm-1 , , arm-2 ' X86_64_METAL_RUNNER_HOSTS=' , ' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","hosts":"arm-1,arm-2","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS=' , ' X86_64_METAL_RUNNER_HOSTS=' , ' "$HOST_GROUPS" has-groups)
[ "$out" = "false" ] || fail "expected whitespace-only host groups to be false, got: ${out}"

out=$(run_clean "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[]'

out=$(run_clean "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_json_eq "$out" '[]'

out=$(run_clean "$HOST_GROUPS" has-groups)
[ "$out" = "false" ] || fail "expected empty has-groups=false, got: ${out}"

if bash -c '. "$1"; runner_image_cache_suffix ""' bash "$TARGET" >"${TMPDIR}/cache-empty.out" 2>"${TMPDIR}/cache-empty.err"; then
  fail "expected empty cache suffix target to fail"
fi
grep -q "missing runner image target" "${TMPDIR}/cache-empty.err" || fail "expected missing cache suffix target message"

if bash -c '. "$1"; runner_image_cache_suffix powerpc-unknown-linux-musl' bash "$TARGET" >"${TMPDIR}/cache.out" 2>"${TMPDIR}/cache.err"; then
  fail "expected unsupported cache suffix target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/cache.err" || fail "expected unsupported cache suffix message"

if bash -c '. "$1"; runner_image_asset_suffix ""' bash "$TARGET" >"${TMPDIR}/asset-empty.out" 2>"${TMPDIR}/asset-empty.err"; then
  fail "expected empty asset suffix target to fail"
fi
grep -q "missing runner image target" "${TMPDIR}/asset-empty.err" || fail "expected missing asset suffix target message"

if bash -c '. "$1"; runner_image_asset_suffix powerpc-unknown-linux-musl' bash "$TARGET" >"${TMPDIR}/asset.out" 2>"${TMPDIR}/asset.err"; then
  fail "expected unsupported asset suffix target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/asset.err" || fail "expected unsupported asset suffix message"

echo "runner-host-architecture-groups-test: ok"
