#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-production-rollback-target.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
artifact_dir="${tmp_dir}/artifact"
mkdir -p "$fake_bin" "${artifact_dir}/assets"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

printf '<!doctype html>\n' >"${artifact_dir}/index.html"
printf 'console.log("rollback");\n' >"${artifact_dir}/assets/app.js"
index_sha=$(sha256sum "${artifact_dir}/index.html" | cut -d ' ' -f 1)
index_size=$(stat -c '%s' "${artifact_dir}/index.html")
asset_sha=$(sha256sum "${artifact_dir}/assets/app.js" | cut -d ' ' -f 1)
asset_size=$(stat -c '%s' "${artifact_dir}/assets/app.js")
jq -n \
  --arg commit_sha "$target_commit" \
  --arg index_sha "$index_sha" \
  --argjson index_size "$index_size" \
  --arg asset_sha "$asset_sha" \
  --argjson asset_size "$asset_size" \
  '{
    version: 1,
    commitSha: $commit_sha,
    files: [
      {path: "index.html", sha256: $index_sha, size: $index_size},
      {path: "assets/app.js", sha256: $asset_sha, size: $asset_size}
    ]
  }' >"${artifact_dir}/manifest.json"
manifest_sha=$(sha256sum "${artifact_dir}/manifest.json" | cut -d ' ' -f 1)
jq -n \
  --arg commit_sha "$target_commit" \
  --arg manifest_sha "$manifest_sha" \
  '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha}' \
  >"${artifact_dir}/ready.json"

cat >"${fake_bin}/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
case "${1:-}" in
  fetch|cat-file) exit 0 ;;
  merge-base)
    [ "${MOCK_ANCESTRY_VALID:-1}" = "1" ]
    ;;
  tag)
    printf 'vm0-v1.2.3\n'
    ;;
  show)
    printf '[package]\nversion = "1.2.3"\n'
    ;;
  rev-list)
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 2
    ;;
esac
SH

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [[ "$*" == *"api.vercel.com/v6/deployments"* ]]; then
  jq -n \
    --arg sha "$TARGET_COMMIT" \
    --argjson count "${MOCK_VERCEL_MATCH_COUNT:-1}" \
    '{deployments: [range(0; $count) | {
      meta: {githubCommitSha: $sha},
      state: "READY",
      target: "production",
      url: ("api-" + (tostring) + ".vercel.app")
    }]}'
  exit 0
fi

if [ "${MOCK_RUNNER_ASSETS_VALID:-1}" = "1" ]; then
  jq -n '{assets: [
    {name: "runner-v1.2.3-aarch64-linux"},
    {name: "runner-v1.2.3-x86_64-linux"}
  ]}'
else
  jq -n '{assets: [{name: "runner-v1.2.3-aarch64-linux"}]}'
fi
SH

cat >"${fake_bin}/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
[ "${1:-}" = "s3" ] && [ "${2:-}" = "cp" ] || exit 2
cp -a "${MOCK_APP_ARTIFACT_DIR}/." "$4/"
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-n" ]; then shift; fi
remote=$1
host=${remote#*@}
case "$host" in
  arm-1) printf 'aarch64\n' ;;
  x86-1) printf 'x86_64\n' ;;
  *) exit 255 ;;
esac
SH
chmod +x "${fake_bin}/git" "${fake_bin}/curl" "${fake_bin}/aws" "${fake_bin}/ssh"

run_resolver() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1 \
    GH_TOKEN=test-github-token \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_REPOSITORY=vm0-ai/vm0 \
    METAL_USER=ci \
    MOCK_APP_ARTIFACT_DIR="$artifact_dir" \
    MOCK_BOUNDARY_LOG="${tmp_dir}/boundaries.log" \
    R2_ACCOUNT_ID=test-account \
    R2_BUCKET_NAME=test-bucket \
    TARGET_COMMIT="$target_commit" \
    VERCEL_ORG_ID=test-org \
    VERCEL_PROJECT_ID=test-project \
    VERCEL_TOKEN=test-vercel-token \
    "$@" \
    bash "$script"
}

assert_failure() {
  local expected_message=$1
  shift
  if "$@" >"${tmp_dir}/failure.out" 2>"${tmp_dir}/failure.err"; then
    fail "expected command to fail: ${expected_message}"
  fi
  grep -q "$expected_message" "${tmp_dir}/failure.err" || fail "missing failure message: ${expected_message}"
}

: >"${tmp_dir}/boundaries.log"
output_file="${tmp_dir}/success.output"
run_resolver "$output_file" >"${tmp_dir}/success.log"
grep -qx "target_commit=${target_commit}" "$output_file" || fail "missing target commit output"
grep -qx "api_deployment_url=https://api-0.vercel.app" "$output_file" || fail "missing API deployment output"
grep -qx "runner_version=1.2.3" "$output_file" || fail "missing Runner version output"
runner_matrix=$(sed -n 's/^runner_matrix=//p' "$output_file")
jq -e 'length == 2 and .[0].id == "arm64" and .[1].id == "x86_64"' >/dev/null <<<"$runner_matrix" || fail "unexpected Runner matrix"
grep -q "aws s3 cp s3://test-bucket/okou-app/${target_commit}/" "${tmp_dir}/boundaries.log" || fail "full App artifact was not downloaded"

: >"${tmp_dir}/boundaries.log"
assert_failure "found 0" run_resolver "${tmp_dir}/zero.output" MOCK_VERCEL_MATCH_COUNT=0
[ ! -s "${tmp_dir}/zero.output" ] || fail "failed resolution must not publish outputs"
if grep -q '^aws ' "${tmp_dir}/boundaries.log"; then
  fail "App preflight must not start after API resolution failure"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "found 2" run_resolver "${tmp_dir}/multiple.output" MOCK_VERCEL_MATCH_COUNT=2
[ ! -s "${tmp_dir}/multiple.output" ] || fail "ambiguous API resolution must not publish outputs"

corrupt_artifact_dir="${tmp_dir}/corrupt-artifact"
cp -a "$artifact_dir" "$corrupt_artifact_dir"
printf 'corrupt\n' >>"${corrupt_artifact_dir}/assets/app.js"
: >"${tmp_dir}/boundaries.log"
artifact_dir_before=$artifact_dir
artifact_dir=$corrupt_artifact_dir
assert_failure "artifact file does not match manifest" run_resolver "${tmp_dir}/corrupt.output"
artifact_dir=$artifact_dir_before
[ ! -s "${tmp_dir}/corrupt.output" ] || fail "corrupt App artifact must not publish outputs"
if grep -q 'api.github.com' "${tmp_dir}/boundaries.log"; then
  fail "Runner asset resolution must not start after App preflight failure"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "is missing runner-v1.2.3-x86_64-linux" run_resolver "${tmp_dir}/missing-runner.output" MOCK_RUNNER_ASSETS_VALID=0
[ ! -s "${tmp_dir}/missing-runner.output" ] || fail "missing Runner asset must not publish outputs"

invalid_commit=not-a-full-sha
target_commit_before=$target_commit
target_commit=$invalid_commit
: >"${tmp_dir}/boundaries.log"
assert_failure "must be a full lowercase SHA-1" run_resolver "${tmp_dir}/invalid.output"
target_commit=$target_commit_before
[ ! -s "${tmp_dir}/boundaries.log" ] || fail "invalid target must fail before external boundaries"

ruby -e '
  require "yaml"
  rollback_config = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_config = YAML.safe_load(File.read(ARGV[1]), aliases: true)
  raise "rollback must not use lossy GitHub concurrency" if rollback_config.key?("concurrency")
  raise "release must not use lossy GitHub concurrency" if release_config.key?("concurrency")
  rollback = rollback_config.fetch("jobs")
  release = release_config.fetch("jobs")
  raise "rollback resolver must wait for queue" unless rollback.fetch("resolve-target").fetch("needs") == "queue-production-deploy"
  raise "App must wait for resolver" unless rollback.fetch("rollback-app").fetch("needs") == "resolve-target"
  raise "Runner must wait for resolver" unless rollback.fetch("rollback-runner").fetch("needs") == "resolve-target"
  api_needs = rollback.fetch("rollback-api").fetch("needs")
  raise "API must wait for App and Runner" unless ["resolve-target", "rollback-app", "rollback-runner"].all? { |job| api_needs.include?(job) }
  raise "release must wait for production queue" unless release.fetch("release-please").fetch("needs") == "queue-production-deploy"
' "${repo_root}/.github/workflows/rollback-production.yml" "${repo_root}/.github/workflows/release-please.yml"

echo "resolve-production-rollback-target tests passed"
