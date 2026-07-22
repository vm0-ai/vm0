#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
workflow_json=$(yq -o=json '.' "$WORKFLOW")

jq -e '
  .jobs.prepare["runs-on"] == "ubuntu-latest" and
  (.jobs.prepare | has("container") | not) and
  .jobs.prepare.permissions.actions == "read" and
  .jobs.prepare.outputs["runner-binary-compile-matrix"] == "${{ steps.binary-plan.outputs.compile-matrix }}" and
  any(.jobs.prepare.steps[];
    .id == "binary-plan" and
    .run == ".github/scripts/runner-binary-cache-plan.sh" and
    .env.RUNNER_BINARY_CACHE_FORCE_MISS == "${{ vars.RUNNER_BINARY_CACHE_FORCE_MISS }}"
  ) and
  any(.jobs.prepare.steps[];
    .uses == "actions/upload-artifact@v7" and
    .with.name == "runner-binary-hits-${{ github.run_id }}-${{ github.run_attempt }}" and
    .with["compression-level"] == 1 and
    (. | has("continue-on-error") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "prepare must own bounded pre-container hit planning and required transport upload"

jq -e '
  .jobs.compile["runs-on"] == "ubuntu-latest-8-cores" and
  (.jobs.compile.container.image | startswith("ghcr.io/vm0-ai/vm0-toolchain-rust@sha256:")) and
  (.jobs.compile.if | contains("runner-binary-miss-count != '\''0'\''")) and
  .jobs.compile.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-binary-compile-matrix) }}" and
  any(.jobs.compile.steps[]; .uses == "mozilla-actions/sccache-action@v0.0.10") and
  any(.jobs.compile.steps[]; .uses == "Swatinem/rust-cache@v2") and
  any(.jobs.compile.steps[]; .run == ".github/scripts/runner-binary-build/build.sh build") and
  any(.jobs.compile.steps[];
    .uses == "actions/upload-artifact@v7" and
    .with.name == "runner-binary-compiled-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.target }}" and
    (. | has("continue-on-error") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "compile must be a required miss-only Rust/cache/build matrix"

jq -e '
  ([.jobs | to_entries[] |
    select(any(.value.steps[]?; .uses == "mozilla-actions/sccache-action@v0.0.10")) |
    .key] == ["compile"]) and
  ([.jobs | to_entries[] |
    select(any(.value.steps[]?; .uses == "Swatinem/rust-cache@v2")) |
    .key] == ["compile"])
' <<<"$workflow_json" >/dev/null || fail "compiler caches must exist only in the miss-only compile job"

jq -e '
  .jobs.build.name == "Build runner image (${{ matrix.label }})" and
  .jobs.build["runs-on"] == "ubuntu-latest" and
  (.jobs.build | has("container") | not) and
  .jobs.build.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-host-groups-matrix) }}" and
  (.jobs.build.if | contains("needs.compile.result == '\''skipped'\''")) and
  (.jobs.build.if | contains("needs.compile.result == '\''success'\''")) and
  any(.jobs.build.steps[];
    .name == "Download validated runner binary hit" and
    (.if | contains("runner-binary-hit-targets"))
  ) and
  any(.jobs.build.steps[];
    .name == "Download compiled runner binary" and
    .with.name == "runner-binary-compiled-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.target }}"
  ) and
  any(.jobs.build.steps[];
    .run == ".github/scripts/prepare-runner-image.sh" and
    .env.RUNNER_PATH == "runner-binary-transport/${{ matrix.target }}/runner" and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.binary-input.outputs.binary-input-digest }}"
  )
' <<<"$workflow_json" >/dev/null || fail "build must preserve the all-target host readiness contract for hits and misses"

jq -e '
  (.jobs.asset.needs | sort) == ["compile", "prepare"] and
  (.jobs.asset.if | contains("runner-binary-miss-count != '\''0'\''")) and
  .jobs.asset.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-binary-compile-matrix) }}" and
  any(.jobs.asset.steps[];
    .name == "Download compiled runner binary" and
    .with.name == "runner-binary-compiled-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.target }}"
  )
' <<<"$workflow_json" >/dev/null || fail "reusable publication must run only for compiled misses"

prepare_consumers=$(jq -r '[.jobs | to_entries[] |
  select(any(.value.steps[]?; .run == ".github/scripts/prepare-runner-image.sh")) |
  .key] | join(",")' <<<"$workflow_json")
[ "$prepare_consumers" = "build" ] || fail "host preparation must run only in the all-target build job"

echo "runner-image-workflow-test: ok"
