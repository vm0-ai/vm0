#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLASSIFIER="${SCRIPT_DIR}/mitm-addon-only-changed.sh"
CRATES_WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"
SECURITY_WORKFLOW="${REPO_ROOT}/.github/workflows/security.yml"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for command in git jq yq; do
  command -v "$command" >/dev/null || fail "$command is required"
done

repo="${TEST_ROOT}/repo"
mkdir -p \
  "${repo}/.github/scripts" \
  "${repo}/.github/workflows" \
  "${repo}/crates/runner/mitm-addon/src" \
  "${repo}/crates/runner/mitm-addon/tests" \
  "${repo}/crates/runner/src"
cp "$CLASSIFIER" "${repo}/.github/scripts/mitm-addon-only-changed.sh"
chmod +x "${repo}/.github/scripts/mitm-addon-only-changed.sh"

printf 'name: crates\n' > "${repo}/.github/workflows/crates.yml"
printf '[workspace]\n' > "${repo}/crates/Cargo.toml"
printf 'fn main() {}\n' > "${repo}/crates/runner/build.rs"
printf 'fn main() {}\n' > "${repo}/crates/runner/src/main.rs"
printf 'print("addon")\n' > "${repo}/crates/runner/mitm-addon/src/addon.py"
printf 'print("rename")\n' > "${repo}/crates/runner/mitm-addon/src/rename.py"
printf 'def test_addon(): pass\n' > "${repo}/crates/runner/mitm-addon/tests/test_addon.py"
printf '[project]\nname = "addon"\n' > "${repo}/crates/runner/mitm-addon/pyproject.toml"
printf 'version = 1\n' > "${repo}/crates/runner/mitm-addon/uv.lock"

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
git -C "$repo" add --all
git -C "$repo" commit -qm baseline

run_classifier() {
  local base_ref=$1
  (
    cd "$repo"
    .github/scripts/mitm-addon-only-changed.sh "$base_ref"
  )
}

assert_status() {
  local expected=$1 base_ref=$2 label=$3 output status
  if output=$(run_classifier "$base_ref" 2>&1); then
    status=0
  else
    status=$?
  fi
  if [ "$status" -ne "$expected" ]; then
    fail "${label}: expected status ${expected}, got ${status}: ${output}"
  fi
}

commit_change() {
  local path=$1 label=$2
  printf '\n# %s\n' "$label" >> "${repo}/${path}"
  git -C "$repo" add -- "$path"
  git -C "$repo" commit -qm "$label"
}

assert_path_status() {
  local expected=$1 path=$2 label=$3 base_ref
  base_ref=$(git -C "$repo" rev-parse HEAD)
  commit_change "$path" "$label"
  assert_status "$expected" "$base_ref" "$label"
}

empty_base=$(git -C "$repo" rev-parse HEAD)
assert_status 1 "$empty_base" "empty change set"

assert_path_status 0 \
  crates/runner/mitm-addon/src/addon.py \
  "addon source"
assert_path_status 0 \
  crates/runner/mitm-addon/tests/test_addon.py \
  "addon tests"
assert_path_status 0 \
  crates/runner/mitm-addon/pyproject.toml \
  "addon project configuration"
assert_path_status 0 \
  crates/runner/mitm-addon/uv.lock \
  "addon lockfile"

assert_path_status 1 crates/runner/src/main.rs "runner Rust source"
assert_path_status 1 crates/runner/build.rs "runner build script"
assert_path_status 1 crates/Cargo.toml "Cargo workspace configuration"
assert_path_status 1 .github/workflows/crates.yml "shared workflow"

mixed_base=$(git -C "$repo" rev-parse HEAD)
printf '\n# mixed addon\n' >> "${repo}/crates/runner/mitm-addon/src/addon.py"
printf '\n// mixed Rust\n' >> "${repo}/crates/runner/src/main.rs"
git -C "$repo" add -- \
  crates/runner/mitm-addon/src/addon.py \
  crates/runner/src/main.rs
git -C "$repo" commit -qm "mixed addon and Rust"
assert_status 1 "$mixed_base" "mixed addon and Rust"

rename_base=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" mv \
  crates/runner/mitm-addon/src/rename.py \
  crates/runner/src/rename.py
git -C "$repo" commit -qm "cross-boundary rename"
assert_status 1 "$rename_base" "cross-boundary rename"

assert_status 2 does-not-exist "invalid base ref"

crates_json=$(yq -o=json '.' "$CRATES_WORKFLOW")
security_json=$(yq -o=json '.' "$SECURITY_WORKFLOW")

jq -e '
  .jobs.detect.outputs["mitm-addon-only-changed"] ==
    "${{ steps.detect.outputs.mitm-addon-only-changed }}"
' <<<"$crates_json" >/dev/null || fail "detect must publish addon-only classification"

jq -e '
  any(.jobs.detect.steps[];
    .id == "detect" and
    (.run | contains(".github/scripts/mitm-addon-only-changed.sh \"$BASE_REF\"")) and
    (.run | contains("mitm-addon-only-changed=true")) and
    (.run | contains("mitm-addon-only-changed=false"))
  )
' <<<"$crates_json" >/dev/null || fail "detect must map classifier statuses to explicit outputs"

jq -e '
  .jobs.check.if == "needs.detect.outputs.any-changed == '\''true'\''"
' <<<"$crates_json" >/dev/null || fail "check job must remain selected for addon-only changes"

for step_name in "Check formatting" "Run clippy" "Build documentation"; do
  jq -e --arg step_name "$step_name" '
    any(.jobs.check.steps[];
      .name == $step_name and
      .if == "needs.detect.outputs.mitm-addon-only-changed != '\''true'\''"
    )
  ' <<<"$crates_json" >/dev/null || fail "${step_name} must skip only for explicit addon-only changes"
done

jq -e '
  any(.jobs.check.steps[];
    .name == "Check runner and mitm-addon version contract" and
    .if == "needs.detect.outputs.mitm-addon-only-changed == '\''true'\''" and
    (.run | contains("cargo test -p runner --bin runner")) and
    (.run | contains("deps::tests::mitmproxy_version_contract_matches_python_runtime_and_tests")) and
    (.run | contains("--exact"))
  )
' <<<"$crates_json" >/dev/null || fail "addon-only check must run the focused runner contract"

jq -e '
  (.jobs.coverage.if | contains("needs.detect.outputs.any-changed == '\''true'\''")) and
  (.jobs.coverage.if | contains("needs.detect.outputs.mitm-addon-only-changed != '\''true'\''"))
' <<<"$crates_json" >/dev/null || fail "coverage must fail closed and skip only addon-only changes"

jq -e '
  (.jobs["mitm-addon-test"].if | contains("needs.detect.outputs.any-changed == '\''true'\''")) and
  (.jobs["mitm-addon-test"].if | contains("mitm-addon-only-changed") | not)
' <<<"$crates_json" >/dev/null || fail "addon Python checks must remain selected independently"

jq -e '
  (.jobs["runner-build"].if | contains("crates-runner-consumer-needed")) and
  (.jobs["runner-build"].if | contains("mitm-addon-only-changed") | not)
' <<<"$crates_json" >/dev/null || fail "runner build selection must not use addon-only classification"

jq -e '
  any(.jobs["ci-gate-crates"].steps[];
    .name == "Validate CI results" and
    (.run | contains("check_result \"check\" \"${{ needs.check.result }}\" \"true\"")) and
    (.run | contains("check_result \"coverage\" \"${{ needs.coverage.result }}\" \"true\""))
  )
' <<<"$crates_json" >/dev/null || fail "Crates gate must accept relevance-based check and coverage skips"

jq -e '
  any(.jobs.actionlint.steps[];
    .name == "Run workflow script tests" and
    (.run | contains(".github/scripts/mitm-addon-only-changed.sh")) and
    (.run | contains(".github/scripts/tests/mitm-addon-ci-selection-test.sh"))
  )
' <<<"$security_json" >/dev/null || fail "Security CI must ShellCheck the addon CI scripts"

echo "mitm-addon-ci-selection-test: ok"
