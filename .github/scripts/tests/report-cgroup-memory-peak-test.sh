#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPORTER="${REPO_ROOT}/.github/actions/report-memory-peak/report.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local value=$1 expected=$2
  [[ "$value" == *"$expected"* ]] || fail "expected '${expected}' in '${value}'"
}

run_reporter() {
  local fixture=$1
  env -i \
    PATH="$PATH" \
    OKOU_CGROUP_ROOT="${fixture}/cgroup" \
    OKOU_PROC_CGROUP="${fixture}/proc-self-cgroup" \
    OKOU_MEMORY_REPORT_LABEL="test-job" \
    GITHUB_STEP_SUMMARY="${fixture}/summary.md" \
    bash "$REPORTER" 2>&1
}

fixture="${TEST_ROOT}/v2-nested"
mkdir -p "${fixture}/cgroup/github/job"
printf '0::/github/job\n' > "${fixture}/proc-self-cgroup"
printf '2147483648\n' > "${fixture}/cgroup/github/job/memory.peak"
output=$(run_reporter "$fixture")
assert_contains "$output" "Peak memory (test-job): 2048.0 MiB (2147483648 bytes; cgroup v2 memory.peak)"
assert_contains "$(<"${fixture}/summary.md")" "Peak memory: **2048.0 MiB** (\`2147483648 bytes\`)"

fixture="${TEST_ROOT}/v2-namespaced"
mkdir -p "${fixture}/cgroup"
printf '0::/github/job\n' > "${fixture}/proc-self-cgroup"
printf '1048576\n' > "${fixture}/cgroup/memory.peak"
output=$(run_reporter "$fixture")
assert_contains "$output" "Peak memory (test-job): 1.0 MiB (1048576 bytes; cgroup v2 memory.peak)"

fixture="${TEST_ROOT}/v1"
mkdir -p "${fixture}/cgroup/memory/github/job"
printf '5:memory:/github/job\n' > "${fixture}/proc-self-cgroup"
printf '1572864\n' > "${fixture}/cgroup/memory/github/job/memory.max_usage_in_bytes"
output=$(run_reporter "$fixture")
assert_contains "$output" "Peak memory (test-job): 1.5 MiB (1572864 bytes; cgroup v1 memory.max_usage_in_bytes)"

fixture="${TEST_ROOT}/unavailable"
mkdir -p "${fixture}/cgroup/github/job"
printf '0::/github/job\n' > "${fixture}/proc-self-cgroup"
printf 'max\n' > "${fixture}/cgroup/github/job/memory.peak"
output=$(run_reporter "$fixture")
assert_contains "$output" "Peak memory (test-job) unavailable: no supported readable cgroup metric"
assert_contains "$(<"${fixture}/summary.md")" "Peak memory: unavailable"

echo "report-cgroup-memory-peak-test: ok"
