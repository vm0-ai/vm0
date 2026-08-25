#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
workflow="${repo_root}/.github/workflows/release-please.yml"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

target_sha=2db202a9412368457b40f8bb5374d7302982ef52
main_sha=fbb7a4a7a8907254b9b98592cd4f5c8f18051edf
wrong_sha=cccccccccccccccccccccccccccccccccccccccc
release_fixture="${tmp_dir}/releases.json"
missing_app_fixture="${tmp_dir}/missing-app-releases.json"
recovery_script="${tmp_dir}/recovery.sh"

ruby -e '
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  step = workflow.fetch("jobs").fetch("release-please").fetch("steps").find { |candidate| candidate["id"] == "recovery_release" }
  raise "missing recovery mapping step" unless step
  puts step.fetch("run")
' "$workflow" >"$recovery_script"
chmod +x "$recovery_script"

jq -n --arg sha "$target_sha" '[
  {target_commitish: $sha, draft: false, tag_name: "api-v1.488.1"},
  {target_commitish: $sha, draft: false, tag_name: "db-v1.223.2"},
  {target_commitish: $sha, draft: false, tag_name: "app-v0.794.1"},
  {target_commitish: $sha, draft: false, tag_name: "runner-rs-v0.173.2"},
  {target_commitish: $sha, draft: false, tag_name: "core-v8.590.2"}
]' >"$release_fixture"
jq 'map(select(.tag_name != "app-v0.794.1"))' "$release_fixture" >"$missing_app_fixture"

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

[ "${1:-}" = "api" ] || {
  echo "unexpected gh command: $*" >&2
  exit 2
}
route=${2:-}
repo="${MOCK_REPO:?}"
target_sha="${MOCK_TARGET_SHA:?}"
main_sha="${MOCK_MAIN_SHA:?}"

if [ "$route" = "repos/${repo}/commits/main" ]; then
  printf '%s\n' "$main_sha"
elif [ "$route" = "repos/${repo}/commits/${target_sha}" ]; then
  printf '%s\n' "$target_sha"
elif [ "$route" = "repos/${repo}/compare/${target_sha}...${main_sha}" ]; then
  printf '%s\n' "${MOCK_LINEAGE:-ahead}"
elif [ "$route" = "repos/${repo}/releases?per_page=100" ]; then
  cat "${MOCK_RELEASES_FILE:?}"
elif [[ "$route" == "repos/${repo}/commits/"* ]]; then
  tag=${route##*/commits/}
  if [ "${MOCK_WRONG_TAG:-}" = "$tag" ]; then
    printf '%s\n' "${MOCK_WRONG_TAG_SHA:?}"
  else
    printf '%s\n' "$target_sha"
  fi
else
  echo "unexpected gh api route: $route" >&2
  exit 2
fi
SH
chmod +x "${fake_bin}/gh"

run_recovery() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-github-token \
    GITHUB_OUTPUT="$output_file" \
    MOCK_MAIN_SHA="$main_sha" \
    MOCK_RELEASES_FILE="$release_fixture" \
    MOCK_REPO=vm0-ai/vm0 \
    MOCK_TARGET_SHA="$target_sha" \
    REPO=vm0-ai/vm0 \
    RECOVERY_RELEASE_SHA="$target_sha" \
    "$@" \
    bash "$recovery_script"
}

assert_failure() {
  local expected_message=$1
  shift
  if "$@" >"${tmp_dir}/failure.log" 2>&1; then
    fail "expected command to fail: ${expected_message}"
  fi
  grep -q "$expected_message" "${tmp_dir}/failure.log" || fail "missing failure message: ${expected_message}"
}

success_output="${tmp_dir}/success.output"
run_recovery "$success_output"
grep -qx "releases_created=true" "$success_output" || fail "recovery did not report releases_created"
grep -qx "release_target=${target_sha}" "$success_output" || fail "recovery did not preserve the exact target"
grep -qx "api_version=1.488.1" "$success_output" || fail "recovery did not map API version"
grep -qx "app_version=0.794.1" "$success_output" || fail "recovery did not map App version"
grep -qx "runner_rs_version=0.173.2" "$success_output" || fail "recovery did not map Runner version"

wrong_target_output="${tmp_dir}/wrong-target.output"
assert_failure \
  "only supports incident release SHA" \
  run_recovery "$wrong_target_output" RECOVERY_RELEASE_SHA="$wrong_sha"
[ ! -s "$wrong_target_output" ] || fail "wrong incident target must not publish outputs"

wrong_lineage_output="${tmp_dir}/wrong-lineage.output"
assert_failure \
  "not an ancestor" \
  run_recovery "$wrong_lineage_output" MOCK_LINEAGE=behind
[ ! -s "$wrong_lineage_output" ] || fail "wrong ancestry must not publish outputs"

wrong_tag_output="${tmp_dir}/wrong-tag.output"
assert_failure \
  "targets ${wrong_sha}" \
  run_recovery \
  "$wrong_tag_output" \
  MOCK_WRONG_TAG=app-v0.794.1 \
  MOCK_WRONG_TAG_SHA="$wrong_sha"
[ ! -s "$wrong_tag_output" ] || fail "wrong tag target must not publish outputs"

missing_release_output="${tmp_dir}/missing-release.output"
assert_failure \
  "missing a required API/DB/App/Runner release" \
  run_recovery "$missing_release_output" MOCK_RELEASES_FILE="$missing_app_fixture"
[ ! -s "$missing_release_output" ] || fail "missing required release must not publish outputs"

echo "release recovery tests passed"
