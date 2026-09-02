#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-app-preview-alias.sh"

test "$(bash "$script" pull_request 22085 '')" = "pr-22085-app"
test "$(bash "$script" merge_group '' 'gh-readonly-queue/main/pr-22085-deadbeef')" = "pr-22085-app"
test "$(bash "$script" push '' '')" = "staging-app"

if bash "$script" merge_group '' 'gh-readonly-queue/main/no-pr' >/dev/null 2>&1; then
  echo "expected a merge group ref without a PR number to be rejected" >&2
  exit 1
fi

if bash "$script" workflow_dispatch '' '' >/dev/null 2>&1; then
  echo "expected an unsupported GitHub event to be rejected" >&2
  exit 1
fi

echo "resolve-app-preview-alias tests passed"
