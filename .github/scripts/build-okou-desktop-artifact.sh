#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "Usage: $0 <commit-sha> <desktop-version> <app-directory> <output-directory>" >&2
  exit 1
fi

commit_sha="$1"
desktop_version="$2"
app_dir="${3%/}"
output_dir="$4"

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Desktop artifact commit must be a full lowercase SHA-1: $commit_sha" >&2
  exit 1
fi
if [[ ! "$desktop_version" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Desktop artifact version must be a semantic version: $desktop_version" >&2
  exit 1
fi
if [[ ! -d "$app_dir" || "$(basename "$app_dir")" != "Zero Computer Use.app" ]]; then
  echo "Desktop artifact requires a Zero Computer Use.app directory: $app_dir" >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
rm -f \
  "$output_dir/app.tar.gz" \
  "$output_dir/manifest.json" \
  "$output_dir/ready.json"

COPYFILE_DISABLE=1 tar -czf "$output_dir/app.tar.gz" \
  -C "$(dirname "$app_dir")" \
  "$(basename "$app_dir")"

archive_sha256="$(shasum -a 256 "$output_dir/app.tar.gz" | cut -d ' ' -f 1)"
archive_size="$(wc -c < "$output_dir/app.tar.gz" | tr -d '[:space:]')"
jq -n \
  --arg commit_sha "$commit_sha" \
  --arg desktop_version "$desktop_version" \
  --arg archive_sha256 "$archive_sha256" \
  --argjson archive_size "$archive_size" \
  '{
    version: 1,
    commitSha: $commit_sha,
    desktopVersion: $desktop_version,
    platform: "darwin",
    arch: "arm64",
    appName: "Zero Computer Use.app",
    archive: {
      path: "app.tar.gz",
      sha256: $archive_sha256,
      size: $archive_size
    }
  }' > "$output_dir/manifest.json"

manifest_sha256="$(shasum -a 256 "$output_dir/manifest.json" | cut -d ' ' -f 1)"
jq -n \
  --arg commit_sha "$commit_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha256}' \
  > "$output_dir/ready.json"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$script_dir/verify-okou-desktop-artifact.sh" \
  "$output_dir" \
  "$commit_sha" \
  "$desktop_version"
