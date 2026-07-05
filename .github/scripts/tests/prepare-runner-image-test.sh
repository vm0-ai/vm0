#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREPARE="${SCRIPT_DIR}/prepare-runner-image.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE= \
  "$PREPARE" >"${TMPDIR}/empty.out" 2>"${TMPDIR}/empty.err"; then
  fail "expected empty target to fail"
fi
grep -q "missing runner image target" "${TMPDIR}/empty.err" || fail "expected missing target message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=powerpc-unknown-linux-musl \
  "$PREPARE" >"${TMPDIR}/unsupported.out" 2>"${TMPDIR}/unsupported.err"; then
  fail "expected unsupported target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/unsupported.err" || fail "expected unsupported target message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=' ,  ' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/empty-hosts.out" 2>"${TMPDIR}/empty-hosts.err"; then
  fail "expected empty metal hosts to fail"
fi
grep -q "METAL_HOSTS is empty" "${TMPDIR}/empty-hosts.err" || fail "expected empty metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='bad/host' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-hosts.out" 2>"${TMPDIR}/invalid-hosts.err"; then
  fail "expected invalid metal hosts to fail"
fi
grep -q "invalid METAL_HOSTS entry: bad/host" "${TMPDIR}/invalid-hosts.err" || fail "expected invalid metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='user@host' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-user-host.out" 2>"${TMPDIR}/invalid-user-host.err"; then
  fail "expected user-qualified metal host to fail"
fi
grep -q "invalid METAL_HOSTS entry: user@host" "${TMPDIR}/invalid-user-host.err" || fail "expected user-qualified metal host message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='host-' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-alias.out" 2>"${TMPDIR}/invalid-alias.err"; then
  fail "expected invalid metal host alias to fail"
fi
grep -qF "invalid METAL_HOSTS entry: host-" "${TMPDIR}/invalid-alias.err" || fail "expected invalid metal host alias message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='dev-1, dev-1' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/duplicate-hosts.out" 2>"${TMPDIR}/duplicate-hosts.err"; then
  fail "expected duplicate metal hosts to fail"
fi
grep -q "duplicate METAL_HOSTS entry: dev-1" "${TMPDIR}/duplicate-hosts.err" || fail "expected duplicate metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='Dev-1, dev-1' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/duplicate-hosts-case.out" 2>"${TMPDIR}/duplicate-hosts-case.err"; then
  fail "expected case-insensitive duplicate metal hosts to fail"
fi
grep -q "duplicate METAL_HOSTS entry: dev-1" "${TMPDIR}/duplicate-hosts-case.err" || fail "expected case-insensitive duplicate metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  R2_ACCOUNT_ID=test-account \
  R2_ACCESS_KEY_ID=test-access-key \
  R2_SECRET_ACCESS_KEY=test-secret \
  R2_USER_STORAGES_BUCKET_NAME=legacy-user-storage \
  TARGET_TRIPLE=powerpc-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/legacy-r2-runner-cache-bucket.out" 2>"${TMPDIR}/legacy-r2-runner-cache-bucket.err"; then
  fail "expected unsupported target to fail after legacy R2 cache is disabled"
fi
grep -q "R2_RUNNER_CACHE_BUCKET_NAME is not configured; disabling R2 runner cache for this build" "${TMPDIR}/legacy-r2-runner-cache-bucket.err" || fail "expected legacy R2 cache disable message"
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/legacy-r2-runner-cache-bucket.err" || fail "expected unsupported target after legacy R2 cache warning"

STUB_BIN="${TMPDIR}/bin"
mkdir -p "$STUB_BIN"
cat >"${STUB_BIN}/cargo" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
target="aarch64-unknown-linux-musl"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--target" ]; then
    shift
    target="$1"
  fi
  shift || true
done
mkdir -p "target/${target}/ci"
for binary in guest-agent guest-download guest-init guest-mock-claude guest-mock-codex guest-reseed guest-write-file runner; do
  printf '%s\n' "$binary" >"target/${target}/ci/${binary}"
  chmod +x "target/${target}/ci/${binary}"
done
STUB
chmod +x "${STUB_BIN}/cargo"
cat >"${STUB_BIN}/ssh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
shift
printf '%s\n' "$*" >>"${SSH_LOG}"
case "$*" in
  "uname -m")
    echo "aarch64"
    ;;
  *"--warm-rootfs-cache"*)
    echo "warm should be skipped when runner R2 cache is disabled" >&2
    exit 99
    ;;
  *"/runner build --profile "*)
    echo "rootfs_hash=rootfs-test"
    echo "snapshot_hash=snapshot-test"
    ;;
  bash\ -s\ --*|sudo\ install\ -m\ 755\ /dev/stdin*)
    cat >/dev/null
    ;;
esac
STUB
chmod +x "${STUB_BIN}/ssh"

if ! PATH="${STUB_BIN}:$PATH" \
  SSH_LOG="${TMPDIR}/legacy-r2-success.ssh.log" \
  JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  R2_ACCOUNT_ID=test-account \
  R2_ACCESS_KEY_ID=test-access-key \
  R2_SECRET_ACCESS_KEY=test-secret \
  R2_USER_STORAGES_BUCKET_NAME=legacy-user-storage \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  MANIFEST_PATH="${TMPDIR}/legacy-r2-success-manifest.json" \
  "$PREPARE" >"${TMPDIR}/legacy-r2-success.out" 2>"${TMPDIR}/legacy-r2-success.err"; then
  fail "expected legacy R2-only config to skip warm cache and still build"
fi
grep -q "R2_RUNNER_CACHE_BUCKET_NAME is not configured; disabling R2 runner cache for this build" "${TMPDIR}/legacy-r2-success.err" || fail "expected legacy R2 disable warning"
grep -q "Skipping shared template cache warm: R2 runner cache disabled" "${TMPDIR}/legacy-r2-success.out" || fail "expected warm cache skip message"
if grep -q -- "--warm-rootfs-cache" "${TMPDIR}/legacy-r2-success.ssh.log"; then
  fail "expected warm-rootfs-cache not to run when runner R2 cache is disabled"
fi
grep -q "/runner build --profile vm0/default" "${TMPDIR}/legacy-r2-success.ssh.log" || fail "expected full image build to run"
test -s "${TMPDIR}/legacy-r2-success-manifest.json" || fail "expected manifest to be written"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  R2_ACCOUNT_ID=test-account \
  R2_RUNNER_CACHE_BUCKET_NAME=test-runner-cache \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/partial-r2-runner-cache.out" 2>"${TMPDIR}/partial-r2-runner-cache.err"; then
  fail "expected partial R2 runner cache config to fail"
fi
grep -q "runner R2 cache is partially configured" "${TMPDIR}/partial-r2-runner-cache.err" || fail "expected partial R2 runner cache config message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH= \
  "$PREPARE" >"${TMPDIR}/arch-empty.out" 2>"${TMPDIR}/arch-empty.err"; then
  fail "expected empty expected remote arch to fail"
fi
grep -q "EXPECTED_REMOTE_ARCH is empty" "${TMPDIR}/arch-empty.err" || fail "expected empty expected remote arch message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=x86_64 \
  "$PREPARE" >"${TMPDIR}/arch-mismatch.out" 2>"${TMPDIR}/arch-mismatch.err"; then
  fail "expected expected remote arch mismatch to fail"
fi
grep -q "EXPECTED_REMOTE_ARCH mismatch: aarch64-unknown-linux-musl maps to aarch64, got x86_64" "${TMPDIR}/arch-mismatch.err" || fail "expected expected remote arch mismatch message"

echo "prepare-runner-image-test: ok"
