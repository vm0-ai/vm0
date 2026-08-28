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
  .jobs.detect as $detect |
  .jobs.check as $check |
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
  )
' <<<"$crates_json" >/dev/null || fail "Crates workflow contract changed"

echo "crates-detect-workflow-test: ok"
