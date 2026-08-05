#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <artifact-dir> <expected-commit-sha>" >&2
  exit 1
fi

artifact_dir="$1"
expected_commit_sha="$2"

if [[ ! "$expected_commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected CLI artifact commit must be a full lowercase SHA-1: $expected_commit_sha" >&2
  exit 1
fi

for filename in package.tgz manifest.json ready.json; do
  if [[ ! -f "$artifact_dir/$filename" ]]; then
    echo "CLI artifact is missing $filename" >&2
    exit 1
  fi
done

jq -e \
  --arg commit_sha "$expected_commit_sha" \
  '.version == 1
    and .commitSha == $commit_sha
    and .package.path == "package.tgz"
    and (.package.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.package.size | type == "number" and . > 0)' \
  "$artifact_dir/manifest.json" >/dev/null

package_sha256="$(sha256sum "$artifact_dir/package.tgz" | cut -d ' ' -f 1)"
manifest_package_sha256="$(jq -er '.package.sha256' "$artifact_dir/manifest.json")"
if [[ "$package_sha256" != "$manifest_package_sha256" ]]; then
  echo "CLI package digest does not match manifest" >&2
  exit 1
fi

package_size="$(stat -c '%s' "$artifact_dir/package.tgz")"
manifest_package_size="$(jq -er '.package.size' "$artifact_dir/manifest.json")"
if [[ "$package_size" != "$manifest_package_size" ]]; then
  echo "CLI package size does not match manifest" >&2
  exit 1
fi

manifest_sha256="$(sha256sum "$artifact_dir/manifest.json" | cut -d ' ' -f 1)"
jq -e \
  --arg commit_sha "$expected_commit_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  '.version == 1
    and .commitSha == $commit_sha
    and .manifestSha256 == $manifest_sha256' \
  "$artifact_dir/ready.json" >/dev/null

package_json="$(tar -xOf "$artifact_dir/package.tgz" package/package.json)"
jq -e '
  .name == "@vm0/cli"
  and .bin.zero == "zero.js"
  and ((.dependencies // {}) | length == 0)
  and ((.optionalDependencies // {}) | length == 0)
  and ((.peerDependencies // {}) | length == 0)
' <<< "$package_json" >/dev/null

echo "Verified CLI artifact for $expected_commit_sha"
