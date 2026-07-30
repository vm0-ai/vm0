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
case "$3" in
  */dist.tar.gz)
    tar -czf "$4" \
      -C "$MOCK_APP_ARTIFACT_DIR" \
      --exclude=./manifest.json \
      --exclude=./ready.json \
      .
    ;;
  */manifest.json | */ready.json)
    cp "${MOCK_APP_ARTIFACT_DIR}/$(basename "$3")" "$4"
    ;;
  *)
    echo "unexpected App artifact object: $3" >&2
    exit 2
    ;;
esac
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
grep -q "aws s3 cp s3://test-bucket/okou-app/${target_commit}/dist.tar.gz" "${tmp_dir}/boundaries.log" || fail "full App artifact was not downloaded"
if grep -q -- '--recursive' "${tmp_dir}/boundaries.log"; then
  fail "archived App artifacts must not be downloaded per file"
fi

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

release_target_script="${tmp_dir}/resolve-release-target.sh"
ruby -e '
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_target_step = release_job.fetch("steps").find { |step| step["id"] == "release-target" }
  raise "missing release target resolver step" unless release_target_step
  puts release_target_step.fetch("run")
' "${repo_root}/.github/workflows/release-please.yml" >"$release_target_script"

release_target=cccccccccccccccccccccccccccccccccccccccc
release_outputs=$(jq -nc \
  --arg target "$release_target" \
  '{
    "turbo/apps/api--sha": $target,
    "turbo/apps/platform--sha": $target,
    "turbo/apps/api--body": "release notes",
    releases_created: "true"
  }')
release_target_output="${tmp_dir}/release-target.output"
RELEASE_OUTPUTS="$release_outputs" \
  GITHUB_OUTPUT="$release_target_output" \
  bash "$release_target_script"
grep -qx "sha=${release_target}" "$release_target_output" || fail "release target resolver did not publish the unique release SHA"

missing_release_target_output="${tmp_dir}/missing-release-target.output"
assert_failure \
  "release-please returned no release SHA" \
  env \
  RELEASE_OUTPUTS='{"releases_created":"true"}' \
  GITHUB_OUTPUT="$missing_release_target_output" \
  bash "$release_target_script"
[ ! -s "$missing_release_target_output" ] || fail "missing release SHA must not publish an output"

multiple_release_targets=$(jq -nc '{
  "turbo/apps/api--sha": "cccccccccccccccccccccccccccccccccccccccc",
  "turbo/apps/platform--sha": "dddddddddddddddddddddddddddddddddddddddd"
}')
multiple_release_target_output="${tmp_dir}/multiple-release-target.output"
assert_failure \
  "release-please returned multiple release SHAs" \
  env \
  RELEASE_OUTPUTS="$multiple_release_targets" \
  GITHUB_OUTPUT="$multiple_release_target_output" \
  bash "$release_target_script"
[ ! -s "$multiple_release_target_output" ] || fail "ambiguous release SHAs must not publish an output"

ruby -e '
  require "yaml"
  rollback_config = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_config = YAML.safe_load(File.read(ARGV[1]), aliases: true)
  turbo_config = YAML.safe_load(File.read(ARGV[2]), aliases: true)
  raise "rollback must not use lossy GitHub concurrency" if rollback_config.key?("concurrency")
  raise "release must not use lossy GitHub concurrency" if release_config.key?("concurrency")
  rollback = rollback_config.fetch("jobs")
  release = release_config.fetch("jobs")
  turbo = turbo_config.fetch("jobs")
  raise "rollback resolver must wait for queue" unless rollback.fetch("resolve-target").fetch("needs") == "queue-production-deploy"
  raise "App must wait for resolver" unless rollback.fetch("rollback-app").fetch("needs") == "resolve-target"
  raise "Runner must wait for resolver" unless rollback.fetch("rollback-runner").fetch("needs") == "resolve-target"
  raise "API must wait for resolver" unless rollback.fetch("rollback-api").fetch("needs") == "resolve-target"
  release_job = release.fetch("release-please")
  release_needs = Array(release_job.fetch("needs"))
  raise "release must wait for production queue" unless release_needs.include?("queue-production-deploy")
  raise "release must wait for release detection" unless release_needs.include?("detect-release-commit")
  queue_needs = Array(release.fetch("queue-production-deploy").fetch("needs"))
  raise "production queue must wait for release detection" unless queue_needs.include?("detect-release-commit")
  release_target_output = "$" + "{{ steps.release-target.outputs.sha }}"
  raise "release job must expose the resolved release target" unless release_job.fetch("outputs").fetch("release_target") == release_target_output
  raise "release workflow must not use the triggering workflow SHA as a release target" if File.read(ARGV[1]).include?("github.event.workflow_run.head_sha")

  expected_target = "$" + "{{ needs.release-please.outputs.release_target }}"
  desktop_target = "desktop-v" + "$" + "{{ needs.release-please.outputs.desktop_version }}"
  checkout_ref_exceptions = {
    "queue-production-deploy" => "main",
    "refresh-release-pull-request" => "main",
    "build-desktop-release" => desktop_target,
    "publish-desktop-update-manifest" => desktop_target,
    "update-rollback-dashboard" => "main",
  }
  release.each do |job_name, job|
    checkout_steps = job.fetch("steps", []).select do |step|
      step["uses"].to_s.start_with?("actions/checkout@")
    end
    checkout_steps.each do |checkout_step|
      expected_ref = checkout_ref_exceptions.fetch(job_name, expected_target)
      actual_ref = checkout_step.fetch("with", {})["ref"]
      unless actual_ref == expected_ref
        raise "#{job_name} checkout must use #{expected_ref.inspect}, got #{actual_ref.inspect}"
      end
    end
  end

  host_worker_step = release.fetch("detect-host-worker-deploy-inputs").fetch("steps").find { |step| step["id"] == "detect" }
  raise "Host Worker detection must use the resolved release target" unless host_worker_step.fetch("run").include?("HEAD_SHA=\"#{expected_target}\"")
  schema_step = release.fetch("deploy-api-schema").fetch("steps").find { |step| step["name"] == "Publish Runtime API Schema" }
  raise "Runtime API Schema must use the resolved release target" unless schema_step.fetch("env").fetch("RELEASE_SHA") == expected_target
  dashboard_step = release.fetch("update-rollback-dashboard").fetch("steps").find { |step| step["name"] == "Update rollback dashboard issue" }
  raise "rollback dashboard must use the resolved release target" unless dashboard_step.fetch("env").fetch("RELEASE_TARGET") == expected_target

  artifact_fetch_helper = "fetch-okou-app-artifact.sh"
  release_app_step = release.fetch("promote-app-production").fetch("steps").find { |step| step["id"] == "pages-production" }
  release_app_run = release_app_step.fetch("run")
  raise "release App deployment must use the shared artifact fetcher" unless release_app_run.include?(artifact_fetch_helper)
  raise "release App deployment must not fall back to per-file artifacts" if release_app_run.include?("--recursive")
  rollback_app_step = rollback.fetch("rollback-app").fetch("steps").find { |step| step["id"] == "app" }
  raise "rollback App deployment must use the shared artifact fetcher" unless rollback_app_step.fetch("run").include?(artifact_fetch_helper)

  artifact_upload_step = turbo.fetch("deploy-app").fetch("steps").find { |step| step["name"] == "Upload canonical app artifact" }
  artifact_upload_run = artifact_upload_step.fetch("run")
  raise "deploy-app must upload the archived App artifact" unless artifact_upload_run.include?("/dist.tar.gz")
  raise "deploy-app must not upload per-file App artifacts" if artifact_upload_run.include?("aws s3 cp turbo/apps/platform/dist")
' \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/turbo.yml"

echo "resolve-production-rollback-target tests passed"
