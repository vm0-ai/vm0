#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_RELEASES="${SCRIPT_DIR}/check-release-please-component-releases.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local text=$1 expected=$2
  grep -Fq -- "$expected" <<<"$text" ||
    fail "expected output to contain: ${expected}"
}

expect_success() {
  local repo=$1 merge_base=$2 merge_head=$3 release_head=$4
  local output

  if ! output=$(
    cd "$repo"
    "$CHECK_RELEASES" "$merge_base" "$merge_head" "$release_head" 2>&1
  ); then
    echo "$output" >&2
    fail "expected release presence check to succeed"
  fi
  assert_contains \
    "$output" \
    "all intervening component source changes have releases"
}

expect_failure() {
  local repo=$1 merge_base=$2 merge_head=$3 release_head=$4 expected=$5
  local output

  if output=$(
    cd "$repo"
    "$CHECK_RELEASES" "$merge_base" "$merge_head" "$release_head" 2>&1
  ); then
    fail "expected release presence check to fail"
  fi
  assert_contains "$output" "$expected"
}

setup_repo() {
  local name=$1
  REPO="${TMPDIR}/${name}"
  mkdir -p \
    "${REPO}/crates/runner/mitm-addon/src" \
    "${REPO}/crates/runner/tests" \
    "${REPO}/turbo/apps/api/src" \
    "${REPO}/turbo/apps/app/src" \
    "${REPO}/docs"

  printf 'runner runtime\n' \
    >"${REPO}/crates/runner/mitm-addon/src/runtime.py"
  printf 'runner test\n' >"${REPO}/crates/runner/tests/runtime.test.py"
  printf 'api runtime\n' >"${REPO}/turbo/apps/api/src/index.ts"
  printf 'app runtime\n' >"${REPO}/turbo/apps/app/src/index.ts"
  printf 'documentation\n' >"${REPO}/docs/README.md"

  printf '%s\n' \
    '{"packages":{"crates/runner":{"release-type":"rust","component":"runner-rs"},"turbo/apps/api":{"release-type":"node"},"turbo/apps/app":{"release-type":"node"}}}' \
    >"${REPO}/release-please-config.json"
  printf '%s\n' \
    '{"crates/runner":"1.0.0","turbo/apps/api":"1.0.0","turbo/apps/app":"1.0.0"}' \
    >"${REPO}/.release-please-manifest.json"

  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email test@example.com
  git -C "$REPO" config user.name Test
  git -C "$REPO" add --all
  git -C "$REPO" commit -qm "baseline"
  BASE=$(git -C "$REPO" rev-parse HEAD)
}

update_manifest() {
  local repo=$1 filter=$2
  local output="${repo}/.release-please-manifest.next.json"

  jq -c "$filter" "${repo}/.release-please-manifest.json" >"$output"
  mv "$output" "${repo}/.release-please-manifest.json"
}

create_release_head() {
  local repo=$1 branch=$2 filter=$3

  git -C "$repo" switch -q -C "$branch" "$BASE"
  update_manifest "$repo" "$filter"
  git -C "$repo" add .release-please-manifest.json
  git -C "$repo" commit -qm "chore: release main"
  git -C "$repo" rev-parse HEAD
}

create_merge_head() {
  local repo=$1 branch=$2 merge_base=$3 filter=$4

  git -C "$repo" switch -q -C "$branch" "$merge_base"
  update_manifest "$repo" "$filter"
  git -C "$repo" add .release-please-manifest.json
  git -C "$repo" commit -qm "chore: release main"
  git -C "$repo" rev-parse HEAD
}

setup_repo "missing-runner-release"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q main
printf 'runner source change\n' \
  >>"${REPO}/crates/runner/mitm-addon/src/runtime.py"
printf 'api source change\n' >>"${REPO}/turbo/apps/api/src/index.ts"
git -C "$REPO" add --all
git -C "$REPO" commit -qm "feat: change runner and api"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_failure \
  "$REPO" \
  "$merge_base" \
  "$merge_head" \
  "$release_head" \
  "crates/runner has intervening source changes but no new release"

release_head=$(
  create_release_head \
    "$REPO" \
    release-api-runner \
    '.["turbo/apps/api"] = "1.0.1" | .["crates/runner"] = "1.0.1"'
)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api-runner \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1" | .["crates/runner"] = "1.0.1"'
)
expect_success "$REPO" "$merge_base" "$merge_head" "$release_head"

setup_repo "multiple-missing-releases"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q main
printf 'runner source change\n' \
  >>"${REPO}/crates/runner/mitm-addon/src/runtime.py"
printf 'app source change\n' >>"${REPO}/turbo/apps/app/src/index.ts"
git -C "$REPO" add --all
git -C "$REPO" commit -qm "feat: change runner and app"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
output=""
if output=$(
  cd "$REPO"
  "$CHECK_RELEASES" "$merge_base" "$merge_head" "$release_head" 2>&1
); then
  fail "expected multiple missing releases to fail"
fi
assert_contains "$output" "crates/runner has intervening source changes"
assert_contains "$output" "turbo/apps/app has intervening source changes"
assert_contains "$output" "2 component release(s) missing"

setup_repo "non-source-change"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q main
printf 'documentation change\n' >>"${REPO}/docs/README.md"
printf 'test change\n' >>"${REPO}/crates/runner/tests/runtime.test.py"
git -C "$REPO" add --all
git -C "$REPO" commit -qm "docs: update runner documentation and tests"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_success "$REPO" "$merge_base" "$merge_head" "$release_head"

setup_repo "no-intervening-change"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
merge_base=$BASE
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_success "$REPO" "$merge_base" "$merge_head" "$release_head"

setup_repo "unreleased-config-only-component"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q main
jq -c \
  '.packages["turbo/apps/new-service"] = {"release-type":"node"}' \
  "${REPO}/release-please-config.json" \
  >"${REPO}/release-please-config.next.json"
mv \
  "${REPO}/release-please-config.next.json" \
  "${REPO}/release-please-config.json"
git -C "$REPO" add release-please-config.json
git -C "$REPO" commit -qm "build: configure new component"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_success "$REPO" "$merge_base" "$merge_head" "$release_head"

setup_repo "manifest-race"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api-runner \
    '.["turbo/apps/api"] = "1.0.1" | .["crates/runner"] = "1.0.1"'
)
git -C "$REPO" switch -q main
printf 'runner source change\n' \
  >>"${REPO}/crates/runner/mitm-addon/src/runtime.py"
git -C "$REPO" add --all
git -C "$REPO" commit -qm "feat: change runner"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_failure \
  "$REPO" \
  "$merge_base" \
  "$merge_head" \
  "$release_head" \
  "release PR manifest does not match merge-group head"

setup_repo "invalid-inputs"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
merge_base=$BASE
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_failure \
  "$REPO" \
  missing-revision \
  "$merge_head" \
  "$release_head" \
  "merge-group base is not an available commit"

setup_repo "missing-config"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q main
git -C "$REPO" rm -q release-please-config.json
git -C "$REPO" commit -qm "build: remove release config"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
expect_failure \
  "$REPO" \
  "$merge_base" \
  "$merge_head" \
  "$release_head" \
  "missing Release Please config"

setup_repo "missing-manifest-entry"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    'del(.["crates/runner"]) | .["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q main
printf 'runner source change\n' \
  >>"${REPO}/crates/runner/mitm-addon/src/runtime.py"
git -C "$REPO" add --all
git -C "$REPO" commit -qm "feat: change runner"
merge_base=$(git -C "$REPO" rev-parse HEAD)
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    'del(.["crates/runner"]) | .["turbo/apps/api"] = "1.0.1"'
)
expect_failure \
  "$REPO" \
  "$merge_base" \
  "$merge_head" \
  "$release_head" \
  "release PR manifest is missing a version for crates/runner"

setup_repo "multi-parent-release-head"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
merge_base=$BASE
merge_head=$(
  create_merge_head \
    "$REPO" \
    merge-api \
    "$merge_base" \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q -C release-side "$BASE"
printf 'side\n' >>"${REPO}/docs/README.md"
git -C "$REPO" add --all
git -C "$REPO" commit -qm "docs: side"
git -C "$REPO" switch -q release-api
git -C "$REPO" merge -q --no-ff release-side -m "merge side"
multi_parent_release_head=$(git -C "$REPO" rev-parse HEAD)
expect_failure \
  "$REPO" \
  "$merge_base" \
  "$merge_head" \
  "$multi_parent_release_head" \
  "release PR head must have exactly one parent"

setup_repo "non-ancestor-generation-base"
release_head=$(
  create_release_head \
    "$REPO" \
    release-api \
    '.["turbo/apps/api"] = "1.0.1"'
)
git -C "$REPO" switch -q --orphan unrelated-main
printf 'unrelated\n' >"${REPO}/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm "chore: unrelated history"
merge_base=$(git -C "$REPO" rev-parse HEAD)
printf 'merge group\n' >>"${REPO}/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm "chore: merge group"
merge_head=$(git -C "$REPO" rev-parse HEAD)
expect_failure \
  "$REPO" \
  "$merge_base" \
  "$merge_head" \
  "$release_head" \
  "release PR generation base is not an ancestor of merge-group base"

echo "check-release-please-component-releases-test: ok"
