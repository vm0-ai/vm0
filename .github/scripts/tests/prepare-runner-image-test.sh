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

echo "prepare-runner-image-test: ok"
