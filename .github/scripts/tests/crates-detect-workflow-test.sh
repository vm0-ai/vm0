#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CRATES_WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
crates_json=$(yq -o=json '.' "$CRATES_WORKFLOW")

jq -e '
  def behavior_commands($lane):
    [$lane.steps[]? |
      .run? |
      select(type == "string") |
      select(startswith(".github/scripts/runner-behavior-"))];
  .jobs.detect as $detect |
  .jobs.check as $check |
  .jobs["runner-behavior-lane-a"] as $lane_a |
  .jobs["runner-behavior-lane-b"] as $lane_b |
  .jobs["runner-behavior-lane-c"] as $lane_c |
  .jobs["runner-behavior-lane-d"] as $lane_d |
  .jobs["host-cpu-fairness-test"] as $host_cpu |
  .jobs["ci-gate-crates"] as $gate |
  {
    "any-changed": "${{ steps.detect.outputs.any-changed }}",
    "ci-changed": "${{ steps.detect.outputs.ci-changed }}",
    "mitm-addon-test-inputs-changed": "${{ steps.detect.outputs.mitm-addon-test-inputs-changed }}",
    "mitm-addon-pricing-seed-changed": "${{ steps.detect.outputs.mitm-addon-pricing-seed-changed }}",
    "runner-firewall-contract-inputs-changed": "${{ steps.detect.outputs.runner-firewall-contract-inputs-changed }}",
    "api-contracts-rust-bindings-changed": "${{ steps.detect.outputs.api-contracts-rust-bindings-changed }}",
    "ably-subscriber-changed": "${{ steps.detect.outputs.ably-subscriber-changed }}",
    "api-contracts-changed": "${{ steps.detect.outputs.api-contracts-changed }}",
    "runner-changed": "${{ steps.detect.outputs.runner-changed }}",
    "sandbox-fc-changed": "${{ steps.detect.outputs.sandbox-fc-changed }}",
    "nbd-cow-changed": "${{ steps.detect.outputs.nbd-cow-changed }}",
    "vsock-test-changed": "${{ steps.detect.outputs.vsock-test-changed }}",
    "crates-runner-consumer-needed": "${{ steps.runner-tests.outputs.crates-runner-consumer-needed }}",
    "metal-job-ref": "${{ steps.runner-job-ref.outputs.job-ref }}",
    "runner-image-job-ref": "${{ steps.runner-job-ref.outputs.image-job-ref }}"
  } as $required_outputs |
  $detect["runs-on"] == "ubuntu-latest" and
  ($detect | has("container") | not) and
  any($detect.steps[]?;
    ((.uses // "") | startswith("actions/checkout@")) and
    .with["fetch-depth"] == 2
  ) and
  all($required_outputs | to_entries[]; $detect.outputs[.key] == .value) and
  any($detect.steps[]?;
    .id == "detect" and
    (.run | contains(".github/scripts/changed-base-ref.sh")) and
    (.run | contains("./scripts/crate-changed.sh")) and
    (.run | contains("safe.directory") | not)
  ) and
  any($detect.steps[]?;
    .id == "runner-tests" and
    .run == ".github/scripts/runner-image-context.sh crates-consumer"
  ) and
  any($detect.steps[]?;
    .id == "runner-job-ref" and
    (.run | contains("job-ref=${JOB_REF}")) and
    (.run | contains("image-job-ref=${IMAGE_JOB_REF}"))
  ) and
  any($check.steps[]?;
    .name == "Configure Git safe directory" and
    .run == "git config --global --add safe.directory \"$GITHUB_WORKSPACE\""
  ) and
  ($host_cpu.needs | sort) == ([
    "detect",
    "runner-build",
    "runner-behavior-lane-a",
    "runner-behavior-lane-b",
    "runner-behavior-lane-c",
    "runner-behavior-lane-d"
  ] | sort) and
  ([$lane_a, $lane_b, $lane_c, $lane_d] |
    all(.[]; .needs == ["runner-build"])) and
  behavior_commands($lane_a) == [
    ".github/scripts/runner-behavior-balloon.sh",
    ".github/scripts/runner-behavior-workspace-cache-promotion.sh"
  ] and
  behavior_commands($lane_b) == [
    ".github/scripts/runner-behavior-exec.sh",
    ".github/scripts/runner-behavior-benchmark.sh"
  ] and
  behavior_commands($lane_c) == [
    ".github/scripts/runner-behavior-process-containment.sh",
    ".github/scripts/runner-behavior-cancel.sh",
    ".github/scripts/runner-behavior-systemd-reload.sh"
  ] and
  behavior_commands($lane_d) == [
    ".github/scripts/runner-behavior-drain-resume.sh",
    ".github/scripts/runner-behavior-keep-alive.sh",
    ".github/scripts/runner-behavior-upgrade-local.sh"
  ] and
  $host_cpu.env.TARGET_TRIPLE == "${{ needs.runner-build.outputs.target }}" and
  any($host_cpu.steps[]?;
    .name == "Cross-compile host CPU fairness test" and
    (.run | contains("--test host_cpu_fairness"))
  ) and
  any($host_cpu.steps[]?;
    .name == "Verify weighted host CPU service with real Firecracker Guests" and
    .run == ".github/scripts/runner-behavior-host-cpu-fairness.sh"
  ) and
  ($gate.needs | index("host-cpu-fairness-test")) != null and
  ($gate.needs | index("runner-behavior-lane-d")) != null and
  any($gate.steps[]?;
    .name == "Validate CI results" and
    (.run | contains("needs.host-cpu-fairness-test.result")) and
    (.run | contains("needs.runner-behavior-lane-d.result"))
  )
' <<<"$crates_json" >/dev/null || fail "Crates workflow contract changed"

echo "crates-detect-workflow-test: ok"
