#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
workflow_json=$(yq -o=json '.' "$WORKFLOW")

jq -e '
  .jobs.coverage as $coverage |
  ($coverage["timeout-minutes"] == 20) and
  ($coverage.env.CARGO_PROFILE_TEST_DEBUG == "line-tables-only") and
  ($coverage.env.RUSTFLAGS == "-C prefer-dynamic -C rpath") and
  (any($coverage.steps[];
    .uses == "Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae" and
    .with.workspaces == "crates -> target" and
    .with["shared-key"] == "coverage-line-tables-only-prefer-dynamic-rpath" and
    .with["save-if"] == "${{ github.ref == '\''refs/heads/main'\'' || github.head_ref == '\''perf/issue-29242-rust-coverage-mold'\'' }}"
  )) and
  (any($coverage.steps[];
    .name == "Run tests with coverage" and
    (.run | split("\n") | map(select(length > 0))) == [
      "cd crates",
      "cargo llvm-cov --all-targets --all-features --lcov --output-path lcov.info"
    ]
  )) and
  (any($coverage.steps[];
    .name == "Upload coverage to Codecov" and
    .if == "success() || failure()" and
    .["continue-on-error"] == true and
    .["timeout-minutes"] == 1 and
    .uses == "codecov/codecov-action@v7" and
    .with.files == "crates/lcov.info" and
    .with.flags == "rust"
  )) and
  ([.jobs | to_entries[] | select(.key != "coverage") | .value.env.RUSTFLAGS?] |
    all(. == null))
' <<<"$workflow_json" >/dev/null || fail "Rust coverage workflow contract changed"

echo "rust-coverage-workflow-test: ok"
