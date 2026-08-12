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

bash "$VALIDATOR" off false ""
bash "$VALIDATOR" soft false ""
expect_failure invalid false ""
expect_failure hard false ""
expect_failure hard true ""
expect_failure hard true "https://github.com/vm0-ai/vm0/issues/26370"
bash "$VALIDATOR" \
  hard \
  true \
  "https://github.com/vm0-ai/vm0/issues/26370#issuecomment-123456789"

echo "validate-desktop-migration-policy-test: ok"
