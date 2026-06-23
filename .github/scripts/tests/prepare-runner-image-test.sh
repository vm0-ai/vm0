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
