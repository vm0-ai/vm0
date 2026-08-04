#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-app-preview-ingress-mode.sh"

expect_mode() {
  local expected="$1"
  shift
  local actual
  actual="$(bash "$script" "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected ${expected}, received ${actual}" >&2
    exit 1
  fi
}

expect_failure() {
  if bash "$script" "$@" >/dev/null 2>&1; then
    echo "expected mode resolution to fail: $*" >&2
    exit 1
  fi
}

expect_mode legacy legacy "" pr-24951
expect_mode gateway canary pr-24951 pr-24951
expect_mode legacy canary pr-24951 pr-24952
expect_mode gateway canary staging staging
expect_mode gateway enabled "" pr-24951

expect_failure canary "" pr-24951
expect_failure canary feature-branch pr-24951
expect_failure unexpected "" pr-24951
expect_failure legacy "" feature-branch

echo "resolve-app-preview-ingress-mode tests passed"
