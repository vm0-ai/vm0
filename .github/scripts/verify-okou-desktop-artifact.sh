#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 <artifact-directory> <expected-commit-sha> <expected-desktop-version>" >&2
  exit 1
fi

artifact_dir="$1"
expected_commit_sha="$2"
expected_desktop_version="$3"
archive_path="$artifact_dir/app.tar.gz"
manifest_path="$artifact_dir/manifest.json"
ready_path="$artifact_dir/ready.json"

if [[ ! "$expected_commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected Desktop artifact commit must be a full lowercase SHA-1: $expected_commit_sha" >&2
  exit 1
fi
if [[ ! "$expected_desktop_version" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Expected Desktop artifact version must be a semantic version: $expected_desktop_version" >&2
  exit 1
fi

for artifact_path in "$archive_path" "$manifest_path" "$ready_path"; do
  if [[ ! -f "$artifact_path" ]]; then
    echo "Desktop artifact is missing $(basename "$artifact_path")" >&2
    exit 1
  fi
done

jq -e \
  --arg commit_sha "$expected_commit_sha" \
  --arg desktop_version "$expected_desktop_version" \
  '.version == 1
    and .commitSha == $commit_sha
    and .desktopVersion == $desktop_version
    and .platform == "darwin"
    and .arch == "arm64"
    and .appName == "Zero Computer Use.app"
    and .archive.path == "app.tar.gz"
    and (.archive.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.archive.size | type == "number" and . > 0)' \
  "$manifest_path" >/dev/null

archive_sha256="$(shasum -a 256 "$archive_path" | cut -d ' ' -f 1)"
manifest_archive_sha256="$(jq -er '.archive.sha256' "$manifest_path")"
if [[ "$archive_sha256" != "$manifest_archive_sha256" ]]; then
  echo "Desktop app archive digest does not match manifest" >&2
  exit 1
fi

archive_size="$(wc -c < "$archive_path" | tr -d '[:space:]')"
manifest_archive_size="$(jq -er '.archive.size' "$manifest_path")"
if [[ "$archive_size" != "$manifest_archive_size" ]]; then
  echo "Desktop app archive size does not match manifest" >&2
  exit 1
fi

manifest_sha256="$(shasum -a 256 "$manifest_path" | cut -d ' ' -f 1)"
jq -e \
  --arg commit_sha "$expected_commit_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  '.version == 1
    and .commitSha == $commit_sha
    and .manifestSha256 == $manifest_sha256' \
  "$ready_path" >/dev/null

archive_entries="$(tar -tzf "$archive_path")"
if [[ -z "$archive_entries" ]]; then
  echo "Desktop app archive is empty" >&2
  exit 1
fi
while IFS= read -r entry; do
  case "$entry" in
    "Zero Computer Use.app" | "Zero Computer Use.app/" | "Zero Computer Use.app/"*) ;;
    *)
      echo "Desktop app archive contains an unexpected path: $entry" >&2
      exit 1
      ;;
  esac
  if [[ "$entry" == /* || "/$entry/" == *"/../"* ]]; then
    echo "Desktop app archive contains an unsafe path: $entry" >&2
    exit 1
  fi
done <<< "$archive_entries"

echo "Verified Desktop artifact for $expected_commit_sha"
