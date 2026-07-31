#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"
TURBO_WORKFLOW="${REPO_ROOT}/.github/workflows/turbo.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
workflow_json=$(yq -o=json '.' "$WORKFLOW")
turbo_workflow_json=$(yq -o=json '.' "$TURBO_WORKFLOW")

jq -e '
  .jobs.prepare.outputs["runner-image-job-ref"] ==
    "${{ steps.set-job-ref.outputs.runner-image-job-ref }}" and
  any(.jobs.prepare.steps[];
    .id == "set-job-ref" and
    (.run | contains("echo \"job-ref=staging\"")) and
    (.run | contains("echo \"runner-image-job-ref=staging-${SHORT_SHA}\""))
  )
' <<<"$turbo_workflow_json" >/dev/null || fail "main runner image directories must remain commit-specific"

jq -e '
  .jobs["deploy-runner-start"].steps[] |
  select(.id == "start") as $start |
  $start.env.RUNNER_SERVICE_REF ==
    "${{ github.event_name == '\''push'\'' && '\''playwright-staging'\'' || needs.prepare.outputs.job-ref }}" and
  $start.env.RUNNER_GROUP ==
    "${{ github.event_name == '\''push'\'' && '\''vm0/playwright-staging'\'' || format('\''vm0/development-{0}'\'', needs.prepare.outputs.job-ref) }}" and
  $start.env.RUNNER_DIR ==
    "${{ needs.deploy-runner-prepare.outputs.runner-dir }}" and
  ($start.run | contains("local RUNNER_NAME=\"${RUNNER_SERVICE_REF}-${HOST_INDEX}\"")) and
  ($start.run | contains("local RUNNER_DIRNAME=\"${RUNNER_DIR##*/}\"")) and
  ($start.run | contains("--runner-dirname ${RUNNER_DIRNAME}")) and
  ($start.run | contains("sudo rm -f ${RUNNER_DIR}/status.json")) and
  ($start.run | contains("--config ${RUNNER_DIR}/runner.yaml"))
' <<<"$turbo_workflow_json" >/dev/null || fail "Playwright service identity and manifest runner directory must remain independent"

jq -e '
  .jobs.prepare.outputs["playwright-runner-consumer-needed"] ==
    "${{ steps.needed.outputs.playwright-runner-consumer-needed }}" and
  any(.jobs.prepare.steps[];
    .id == "turbo" and
    (.run | contains(".github/scripts/runner-image-context.sh playwright-consumer"))
  ) and
  any(.jobs.prepare.steps[];
    .id == "needed" and
    .env.PLAYWRIGHT_RUNNER_CONSUMER_NEEDED ==
      "${{ steps.turbo.outputs.playwright-runner-consumer-needed }}"
  )
' <<<"$workflow_json" >/dev/null || fail "Playwright dedicated-runner demand must reach runner image selection"

jq -e '
  .jobs["cancel-superseded"].name == "Cancel superseded merge-group CI" and
  .jobs["cancel-superseded"].if == "github.event_name == '\''merge_group'\''" and
  .jobs["cancel-superseded"].permissions.actions == "write" and
  .jobs["cancel-superseded"].permissions.contents == "read" and
  .jobs["cancel-superseded"].permissions["pull-requests"] == "read" and
  any(.jobs["cancel-superseded"].steps[];
    .run == ".github/scripts/cancel-superseded-merge-group-runs.sh"
  ) and
  .jobs.prepare.needs == ["cancel-superseded"] and
  (.jobs.prepare.if | contains("!cancelled()")) and
  (.jobs.prepare.if | contains("needs.cancel-superseded.result == '\''success'\''"))
' <<<"$workflow_json" >/dev/null || fail "merge-group consumers must stop before shared runner resources are rebuilt"

jq -e '
  [.jobs | to_entries[] | .value.steps[]? |
    .with.name? // empty |
    select(startswith("runner-binary-hits-") or startswith("runner-binary-compiled-"))
  ] as $transport_names |
  ($transport_names | length) == 5 and
  all($transport_names[]; contains("${{ github.run_id }}")) and
  all($transport_names[]; contains("${{ github.run_attempt }}") | not)
' <<<"$workflow_json" >/dev/null || fail "runner binary transport identity must survive producer and consumer attempt mismatch"

jq -e '
  .jobs.prepare["runs-on"] == "ubuntu-latest" and
  (.jobs.prepare | has("container") | not) and
  .jobs.prepare.permissions.actions == "read" and
  .jobs.prepare.outputs["runner-binary-compile-matrix"] == "${{ steps.binary-plan.outputs.compile-matrix }}" and
  (.jobs.prepare.outputs | has("runner-binary-hit-count") | not) and
  (.jobs.prepare.outputs | has("runner-binary-resolution-json") | not) and
  any(.jobs.prepare.steps[];
    .id == "binary-plan" and
    .run == ".github/scripts/runner-binary-cache-plan.sh" and
    .env.RUNNER_BINARY_CACHE_FORCE_MISS == "${{ vars.RUNNER_BINARY_CACHE_FORCE_MISS }}"
  ) and
  any(.jobs.prepare.steps[];
    .uses == "actions/upload-artifact@v7" and
    .with.name == "runner-binary-hits-${{ github.run_id }}" and
    .with.overwrite == true and
    .if == "steps.binary-plan.outputs.hit-count != '\''0'\''" and
    .with["compression-level"] == 1 and
    (. | has("continue-on-error") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "prepare must own bounded pre-container hit planning and required transport upload"

jq -e '
  .jobs.compile["runs-on"] == "ubuntu-latest-8-cores" and
  (.jobs.compile.container.image | startswith("ghcr.io/vm0-ai/vm0-toolchain-rust@sha256:")) and
  (.jobs.compile.if | contains("!cancelled()")) and
  (.jobs.compile.if | contains("needs.prepare.result == '\''success'\''")) and
  (.jobs.compile.if | contains("runner-binary-miss-count != '\''0'\''")) and
  .jobs.compile.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-binary-compile-matrix) }}" and
  any(.jobs.compile.steps[];
    .name == "Configure git safe directory" and
    .shell == "bash" and
    .run == "git config --global --add safe.directory \"$GITHUB_WORKSPACE\""
  ) and
  ((.jobs.compile.steps | map(.uses // .name) | index("Configure git safe directory")) <
    (.jobs.compile.steps | map(.uses // .name) | index("Build runner binary"))) and
  any(.jobs.compile.steps[]; .uses == "mozilla-actions/sccache-action@v0.0.10") and
  any(.jobs.compile.steps[]; .uses == "Swatinem/rust-cache@v2") and
  any(.jobs.compile.steps[]; .run == ".github/scripts/runner-binary-build/build.sh build") and
  any(.jobs.compile.steps[];
    .uses == "actions/upload-artifact@v7" and
    .with.name == "runner-binary-compiled-${{ github.run_id }}-${{ matrix.target }}" and
    .with.overwrite == true and
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
    (.if | contains("runner-binary-hit-targets")) and
    .with.name == "runner-binary-hits-${{ github.run_id }}"
  ) and
  any(.jobs.build.steps[];
    .name == "Download compiled runner binary" and
    .with.name == "runner-binary-compiled-${{ github.run_id }}-${{ matrix.target }}"
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
    .with.name == "runner-binary-compiled-${{ github.run_id }}-${{ matrix.target }}"
  ) and
  any(.jobs.asset.steps[];
    .name == "Validate fresh runner binary" and
    (. | has("if") | not) and
    (. | has("continue-on-error") | not)
  ) and
  any(.jobs.asset.steps[];
    .name == "Resolve reusable candidate in shadow mode" and
    (. | has("if") | not)
  ) and
  any(.jobs.asset.steps[];
    .name == "Publish runner binary cache object" and
    (. | has("if") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "reusable publication must run only for compiled misses"

prepare_consumers=$(jq -r '[.jobs | to_entries[] |
  select(any(.value.steps[]?; .run == ".github/scripts/prepare-runner-image.sh")) |
  .key] | join(",")' <<<"$workflow_json")
[ "$prepare_consumers" = "build" ] || fail "host preparation must run only in the all-target build job"

echo "runner-image-workflow-test: ok"
