#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALIDATOR="${REPO_ROOT}/.github/scripts/validate-desktop-migration-policy.sh"

expect_failure() {
  if bash "$VALIDATOR" "$@" >/dev/null 2>&1; then
    echo "expected validation failure: $*" >&2
    exit 1
  fi
}

bash "$VALIDATOR" off false "" refs/heads/main
bash "$VALIDATOR" soft false "" refs/heads/main
expect_failure soft false "" refs/heads/feature
expect_failure invalid false "" refs/heads/main
expect_failure hard false "" refs/heads/main
expect_failure hard true "" refs/heads/main
expect_failure \
  hard \
  true \
  "https://github.com/vm0-ai/vm0/issues/26370" \
  refs/heads/main
bash "$VALIDATOR" \
  hard \
  true \
  "https://github.com/vm0-ai/vm0/issues/26370#issuecomment-123456789" \
  refs/heads/main

echo "validate-desktop-migration-policy-test: ok"
