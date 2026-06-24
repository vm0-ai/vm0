#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_GROUPS="${SCRIPT_DIR}/runner-host-architecture-groups.sh"
TARGET="${SCRIPT_DIR}/runner-image-target.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
FAKE_BIN="${TMPDIR}/bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "$FAKE_BIN"
cat > "${FAKE_BIN}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

remote=$1
shift
host=${remote#*@}

if [ "$#" -ne 2 ] || [ "$1" != "uname" ] || [ "$2" != "-m" ]; then
  echo "unexpected ssh command for ${host}: $*" >&2
  exit 2
fi

for entry in ${HOST_ARCHES:-}; do
  if [ "${entry%%=*}" = "$host" ]; then
    printf '%s\n' "${entry#*=}"
    exit 0
  fi
done

echo "missing mock architecture for ${host}" >&2
exit 255
SH
chmod +x "${FAKE_BIN}/ssh"

run_clean() {
  env -i PATH="${FAKE_BIN}:$PATH" HOME="${HOME:-/tmp}" METAL_USER=ci HOST_ARCHES="${HOST_ARCHES:-}" "$@"
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

out=$(bash -c '. "$1"; runner_image_target_for_uname_m aarch64' bash "$TARGET")
[ "$out" = "aarch64-unknown-linux-musl" ] || fail "expected aarch64 target, got: ${out}"

out=$(bash -c '. "$1"; runner_image_target_for_uname_m x86_64' bash "$TARGET")
[ "$out" = "x86_64-unknown-linux-musl" ] || fail "expected x86_64 target, got: ${out}"

out=$(bash -c '. "$1"; runner_image_elf_machine_hex aarch64-unknown-linux-musl' bash "$TARGET")
[ "$out" = "b700" ] || fail "expected aarch64 ELF machine metadata, got: ${out}"

out=$(bash -c '. "$1"; runner_image_elf_machine_hex x86_64-unknown-linux-musl' bash "$TARGET")
[ "$out" = "3e00" ] || fail "expected x86_64 ELF machine metadata, got: ${out}"

if bash -c '. "$1"; runner_image_target_for_uname_m ""' bash "$TARGET" >"${TMPDIR}/uname-empty.out" 2>"${TMPDIR}/uname-empty.err"; then
  fail "expected empty uname target lookup to fail"
fi
grep -q "missing runner host architecture" "${TMPDIR}/uname-empty.err" || fail "expected empty uname message"

if bash -c '. "$1"; runner_image_target_for_uname_m powerpc' bash "$TARGET" >"${TMPDIR}/uname-unsupported.out" 2>"${TMPDIR}/uname-unsupported.err"; then
  fail "expected unsupported uname target lookup to fail"
fi
grep -q "unsupported runner host architecture: powerpc" "${TMPDIR}/uname-unsupported.err" || fail "expected unsupported uname message"

HOST_ARCHES='arm-1=aarch64 arm-2=aarch64'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","hosts":"arm-1,arm-2","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_no_hosts_field "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS" has-groups)
[ "$out" = "true" ] || fail "expected ARM64 has-groups=true, got: ${out}"

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS" hosts arm64)
[ "$out" = "arm-1,arm-2" ] || fail "expected ARM64 hosts, got: ${out}"

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-2' "$HOST_GROUPS" select-host arm64 pr-123-test)
case "$out" in
  arm-1|arm-2) ;;
  *) fail "expected selected ARM64 host to be one host from the group, got: ${out}" ;;
esac

HOST_ARCHES='x86-1=x86_64'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"x86_64","label":"x86_64","hosts":"x86-1","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_no_hosts_field "$out"
assert_json_eq "$out" '[{"id":"x86_64","label":"x86_64","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS" has-groups)
[ "$out" = "true" ] || fail "expected x86_64 has-groups=true, got: ${out}"

out=$(run_clean AWS_METAL_RUNNER_HOSTS='x86-1' "$HOST_GROUPS" hosts x86_64)
[ "$out" = "x86-1" ] || fail "expected x86_64 hosts, got: ${out}"

HOST_ARCHES='arm-1=aarch64 x86-1=x86_64 x86-2=x86_64'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1,x86-1,x86-2' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","hosts":"arm-1","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"},{"id":"x86_64","label":"x86_64","hosts":"x86-1,x86-2","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1,x86-1,x86-2' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_no_hosts_field "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"},{"id":"x86_64","label":"x86_64","target":"x86_64-unknown-linux-musl","unameM":"x86_64","cacheSuffix":"x86_64-musl","assetSuffix":"x86_64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1,x86-1,x86-2' "$HOST_GROUPS" hosts x86_64)
[ "$out" = "x86-1,x86-2" ] || fail "expected mixed x86_64 hosts, got: ${out}"

out=$(run_clean AWS_METAL_RUNNER_HOSTS='arm-1,x86-1,x86-2' "$HOST_GROUPS" select-host x86_64 pr-123-test)
case "$out" in
  x86-1|x86-2) ;;
  *) fail "expected selected x86_64 host to be one host from the group, got: ${out}" ;;
esac

HOST_ARCHES=''
out=$(run_clean "$HOST_GROUPS" select-host x86_64 pr-123-test 'x86-1,x86-2')
case "$out" in
  x86-1|x86-2) ;;
  *) fail "expected selected x86_64 host from explicit hosts to be one host, got: ${out}" ;;
esac

HOST_ARCHES='arm-1=aarch64 arm-2=aarch64'

out=$(run_clean AWS_METAL_RUNNER_HOSTS=' arm-1 , , arm-2 ' "$HOST_GROUPS")
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","hosts":"arm-1,arm-2","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

HOST_ARCHES='runner-1.vm3.ai=aarch64 runner_2=aarch64'

out=$(run_clean AWS_METAL_RUNNER_HOSTS='runner-1.vm3.ai,runner_2' "$HOST_GROUPS" matrix)
assert_compact_json "$out"
assert_json_eq "$out" '[{"id":"arm64","label":"ARM64","target":"aarch64-unknown-linux-musl","unameM":"aarch64","cacheSuffix":"aarch64-musl","assetSuffix":"aarch64-linux"}]'

out=$(run_clean AWS_METAL_RUNNER_HOSTS=' , ' "$HOST_GROUPS" has-groups)
[ "$out" = "false" ] || fail "expected whitespace-only host groups to be false, got: ${out}"

if run_clean AWS_METAL_RUNNER_HOSTS='bad host' "$HOST_GROUPS" >"${TMPDIR}/invalid-space.out" 2>"${TMPDIR}/invalid-space.err"; then
  fail "expected host with whitespace to fail"
fi
grep -q "invalid runner host entry: bad host" "${TMPDIR}/invalid-space.err" || fail "expected host whitespace message"

if run_clean AWS_METAL_RUNNER_HOSTS='bad/host' "$HOST_GROUPS" matrix >"${TMPDIR}/invalid-slash.out" 2>"${TMPDIR}/invalid-slash.err"; then
  fail "expected host with slash to fail"
fi
grep -q "invalid runner host entry: bad/host" "${TMPDIR}/invalid-slash.err" || fail "expected host slash message"

if run_clean AWS_METAL_RUNNER_HOSTS='bad*host' "$HOST_GROUPS" has-groups >"${TMPDIR}/invalid-glob.out" 2>"${TMPDIR}/invalid-glob.err"; then
  fail "expected host with glob character to fail"
fi
grep -q "invalid runner host entry: bad\*host" "${TMPDIR}/invalid-glob.err" || fail "expected host glob message"

for host in -host . .. _host host_ host- host.; do
  if run_clean AWS_METAL_RUNNER_HOSTS="$host" "$HOST_GROUPS" matrix >"${TMPDIR}/invalid-alias.out" 2>"${TMPDIR}/invalid-alias.err"; then
    fail "expected invalid host alias '${host}' to fail"
  fi
  grep -qF "invalid runner host entry: ${host}" "${TMPDIR}/invalid-alias.err" || fail "expected invalid host alias message"
done

if run_clean AWS_METAL_RUNNER_HOSTS='arm-1, arm-1' "$HOST_GROUPS" >"${TMPDIR}/duplicate-group.out" 2>"${TMPDIR}/duplicate-group.err"; then
  fail "expected duplicate host in one group to fail"
fi
grep -q "duplicate runner host configured: arm-1" "${TMPDIR}/duplicate-group.err" || fail "expected duplicate host in one group message"

if run_clean AWS_METAL_RUNNER_HOSTS='Arm-1, arm-1' "$HOST_GROUPS" >"${TMPDIR}/duplicate-case.out" 2>"${TMPDIR}/duplicate-case.err"; then
  fail "expected case-insensitive duplicate host in one group to fail"
fi
grep -q "duplicate runner host configured: arm-1" "${TMPDIR}/duplicate-case.err" || fail "expected case-insensitive duplicate host message"

if HOST_ARCHES='unsupported=ppc64le' run_clean AWS_METAL_RUNNER_HOSTS='unsupported' "$HOST_GROUPS" matrix >"${TMPDIR}/unsupported-host-arch.out" 2>"${TMPDIR}/unsupported-host-arch.err"; then
  fail "expected unsupported host architecture to fail"
fi
grep -q "unsupported runner host architecture for unsupported: ppc64le" "${TMPDIR}/unsupported-host-arch.err" || fail "expected unsupported host architecture message"

if run_clean AWS_METAL_RUNNER_HOSTS='arm-1' "$HOST_GROUPS" hosts >"${TMPDIR}/missing-host-group.out" 2>"${TMPDIR}/missing-host-group.err"; then
  fail "expected missing hosts group id to fail"
fi
grep -q "missing runner host group id" "${TMPDIR}/missing-host-group.err" || fail "expected missing hosts group id message"

if run_clean AWS_METAL_RUNNER_HOSTS='arm-1' "$HOST_GROUPS" hosts powerpc >"${TMPDIR}/unsupported-host-group.out" 2>"${TMPDIR}/unsupported-host-group.err"; then
  fail "expected unsupported hosts group id to fail"
fi
grep -q "unsupported runner host group id: powerpc" "${TMPDIR}/unsupported-host-group.err" || fail "expected unsupported hosts group id message"

if run_clean AWS_METAL_RUNNER_HOSTS='arm-1' "$HOST_GROUPS" select-host arm64 >"${TMPDIR}/missing-selection-key.out" 2>"${TMPDIR}/missing-selection-key.err"; then
  fail "expected missing selection key to fail"
fi
grep -q "missing runner host selection key" "${TMPDIR}/missing-selection-key.err" || fail "expected missing selection key message"

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

if bash -c '. "$1"; runner_image_elf_machine_hex ""' bash "$TARGET" >"${TMPDIR}/elf-empty.out" 2>"${TMPDIR}/elf-empty.err"; then
  fail "expected empty ELF machine target to fail"
fi
grep -q "missing runner image target" "${TMPDIR}/elf-empty.err" || fail "expected missing ELF machine target message"

if bash -c '. "$1"; runner_image_elf_machine_hex powerpc-unknown-linux-musl' bash "$TARGET" >"${TMPDIR}/elf.out" 2>"${TMPDIR}/elf.err"; then
  fail "expected unsupported ELF machine target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/elf.err" || fail "expected unsupported ELF machine message"

echo "runner-host-architecture-groups-test: ok"
