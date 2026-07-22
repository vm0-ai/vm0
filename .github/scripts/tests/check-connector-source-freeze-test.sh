#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-connector-source-freeze.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_pass() {
  local description="$1"
  local output

  if ! output="$(cd "$repo" && "$CHECKER" "$base_sha" HEAD 2>&1)"; then
    fail "expected ${description} to pass, got: ${output}"
  fi
}

expect_fail() {
  local description="$1"
  local expected_path="$2"
  local output

  if output="$(cd "$repo" && "$CHECKER" "$base_sha" HEAD 2>&1)"; then
    fail "expected ${description} to fail"
  fi
  if [[ "$output" != *"$expected_path"* ]]; then
    fail "expected ${description} output to contain '${expected_path}', got: ${output}"
  fi
  if [[ "$output" != *"vm0-connectors"* ]]; then
    fail "expected ${description} output to direct changes to vm0-connectors"
  fi
}

start_case() {
  git -C "$repo" switch -q --detach "$base_sha"
}

commit_case() {
  local message="$1"

  git -C "$repo" add -A
  git -C "$repo" commit -q -m "$message"
}

repo="${TMPDIR}/repo"
connector_dir="${repo}/turbo/packages/connectors/src/connectors"
connector_runtime_dir="${repo}/turbo/packages/connectors/src"
firewall_dir="${repo}/turbo/packages/firewalls-generator/src"

git init -q -b main "$repo"
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
git -C "$repo" config maintenance.auto false
mkdir -p "$connector_dir" "$firewall_dir"
printf 'export const connector = "base";\n' > "${connector_dir}/example.ts"
printf 'export const runtime = "base";\n' > "${connector_runtime_dir}/runtime.ts"
printf 'export const firewall = "base";\n' > "${firewall_dir}/example.ts"
git -C "$repo" add .
git -C "$repo" commit -q -m "base"
base_sha="$(git -C "$repo" rev-parse HEAD)"

expect_pass "an unchanged tree"

start_case
printf 'export const runtime = "changed";\n' > "${connector_runtime_dir}/runtime.ts"
commit_case "modify connector runtime"
expect_pass "changes outside the frozen connector data directory"

start_case
printf 'export const connector = "new";\n' > "${connector_dir}/new.ts"
commit_case "add connector"
expect_fail "a connector addition" "turbo/packages/connectors/src/connectors/new.ts"

start_case
printf 'export const connector = "changed";\n' > "${connector_dir}/example.ts"
commit_case "modify connector"
expect_fail "a connector modification" "turbo/packages/connectors/src/connectors/example.ts"

start_case
rm "${connector_dir}/example.ts"
commit_case "delete connector"
expect_pass "a connector deletion"

start_case
mv "${connector_dir}/example.ts" "${connector_dir}/renamed.ts"
commit_case "rename connector"
expect_fail "a connector rename" "turbo/packages/connectors/src/connectors/renamed.ts"

start_case
mkdir -p "${repo}/archive"
mv "${connector_dir}/example.ts" "${repo}/archive/example.ts"
commit_case "rename connector outside frozen directories"
expect_fail \
  "a connector rename outside the frozen directories" \
  "turbo/packages/connectors/src/connectors/example.ts -> archive/example.ts"

start_case
printf 'export const firewall = "new";\n' > "${firewall_dir}/new.ts"
commit_case "add firewall source"
expect_fail "a firewall source addition" "turbo/packages/firewalls-generator/src/new.ts"

start_case
printf 'export const firewall = "changed";\n' > "${firewall_dir}/example.ts"
commit_case "modify firewall source"
expect_fail "a firewall source modification" "turbo/packages/firewalls-generator/src/example.ts"

start_case
rm "${firewall_dir}/example.ts"
commit_case "delete firewall source"
expect_pass "a firewall source deletion"

echo "check-connector-source-freeze-test: ok"
