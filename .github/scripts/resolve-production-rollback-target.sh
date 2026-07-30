#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    fail "Missing required environment variable: ${name}"
  fi
}

for name in \
  AWS_METAL_RUNNER_HOSTS \
  GH_TOKEN \
  GITHUB_OUTPUT \
  GITHUB_REPOSITORY \
  METAL_USER \
  R2_ACCOUNT_ID \
  R2_BUCKET_NAME \
  TARGET_COMMIT \
  VERCEL_ORG_ID \
  VERCEL_PROJECT_ID \
  VERCEL_TOKEN; do
  require_env "$name"
done

if [[ ! "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "target_commit must be a full lowercase SHA-1: ${TARGET_COMMIT}"
fi

git fetch --force --tags origin main
git cat-file -e "${TARGET_COMMIT}^{commit}"
if ! git merge-base --is-ancestor "$TARGET_COMMIT" origin/main; then
  fail "Target commit is not reachable from main: ${TARGET_COMMIT}"
fi

release_tags=$(git tag --points-at "$TARGET_COMMIT" | grep -E -- '-v[0-9]' || true)
if [ -z "$release_tags" ]; then
  fail "Target commit has no release tags: ${TARGET_COMMIT}"
fi

deployments=$(curl -fsS --get "https://api.vercel.com/v6/deployments" \
  -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  --data-urlencode "teamId=${VERCEL_ORG_ID}" \
  --data-urlencode "projectId=${VERCEL_PROJECT_ID}" \
  --data-urlencode "target=production" \
  --data-urlencode "state=READY" \
  --data-urlencode "meta-githubCommitSha=${TARGET_COMMIT}" \
  --data-urlencode "limit=100")

matches=$(jq -c --arg sha "$TARGET_COMMIT" '[
  (.deployments // [])[]
  | select(.meta.githubCommitSha == $sha)
  | select(.state == "READY")
  | select(.target == "production")
]' <<<"$deployments")
match_count=$(jq -r 'length' <<<"$matches")
if [ "$match_count" -ne 1 ]; then
  fail "Expected exactly one READY production API deployment for ${TARGET_COMMIT}, found ${match_count}."
fi
api_deployment_url="https://$(jq -r '.[0].url' <<<"$matches")"

r2_endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
app_artifact_uri="s3://${R2_BUCKET_NAME}/okou-app/${TARGET_COMMIT}"
app_artifact_dir=$(mktemp -d)
trap 'rm -rf "$app_artifact_dir"' EXIT
bash "${script_dir}/fetch-okou-app-artifact.sh" \
  "$r2_endpoint" \
  "$app_artifact_uri" \
  "$app_artifact_dir"
bash "${script_dir}/verify-okou-app-artifact.sh" \
  "$app_artifact_dir" \
  "$TARGET_COMMIT"

. "${script_dir}/runner-image-target.sh"
runner_version=$(git show "${TARGET_COMMIT}:crates/runner/Cargo.toml" \
  | sed -nE 's/^version = "([^"]+)"/\1/p' \
  | head -1)
if [ -z "$runner_version" ]; then
  fail "Could not resolve Runner version from ${TARGET_COMMIT}."
fi

runner_tag=$(runner_image_release_tag "$runner_version")
runner_tag_commit=$(git rev-list -n 1 "$runner_tag" || true)
if [ -z "$runner_tag_commit" ] || ! git merge-base --is-ancestor "$runner_tag_commit" "$TARGET_COMMIT"; then
  fail "Runner release ${runner_tag} is not reachable from ${TARGET_COMMIT}."
fi

runner_matrix=$("${script_dir}/runner-host-architecture-groups.sh" target-matrix)
runner_group_count=$(jq -r 'length' <<<"$runner_matrix")
if [ "$runner_group_count" -lt 1 ]; then
  fail "No production Runner host groups found."
fi

runner_assets=$(curl -fsSL \
  --retry 5 \
  --retry-delay 2 \
  --retry-max-time 60 \
  --retry-all-errors \
  -H "Authorization: token ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${runner_tag}" \
  | jq -r '.assets[].name')

runner_targets=$(jq -r '.[].target' <<<"$runner_matrix")
while IFS= read -r target; do
  asset_name=$(runner_image_release_asset_name "$runner_version" "$target")
  if ! grep -qx "$asset_name" <<<"$runner_assets"; then
    fail "Runner release ${runner_tag} is missing ${asset_name}."
  fi
done <<<"$runner_targets"

{
  echo "api_deployment_url=$api_deployment_url"
  echo "runner_matrix=$runner_matrix"
  echo "runner_tag=$runner_tag"
  echo "runner_version=$runner_version"
  echo "target_commit=$TARGET_COMMIT"
} >>"$GITHUB_OUTPUT"

echo "Release target: ${TARGET_COMMIT}"
printf '%s\n' "$release_tags"
echo "API target: ${api_deployment_url}"
echo "App target: ${app_artifact_uri}/"
echo "Runner target: ${runner_tag}"
jq . <<<"$runner_matrix"
