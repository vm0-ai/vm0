#!/usr/bin/env bash

# Seed a mountable Storage through the preview-only fixture API.
#
# Usage: seed_storage_fixture <volume|artifact> <name> <source-directory>
seed_storage_fixture() (
    set -euo pipefail

    if [[ "$#" -ne 3 ]]; then
        echo "# Usage: seed_storage_fixture <volume|artifact> <name> <source-directory>" >&2
        return 1
    fi

    local legacy_kind="$1"
    local storage_name="$2"
    local source_directory="$3"

    local storage_owner
    case "$legacy_kind" in
        volume) storage_owner="organization" ;;
        artifact) storage_owner="user" ;;
        *)
            echo "# Unsupported storage fixture kind: $legacy_kind" >&2
            return 1
            ;;
    esac

    if [[ ! -d "$source_directory" ]]; then
        echo "# Storage fixture directory not found: $source_directory" >&2
        return 1
    fi

    source_directory="$(cd "$source_directory" && pwd -P)"

    local fixture_tmp_dir
    fixture_tmp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$fixture_tmp_dir"' EXIT

    local file_list="$fixture_tmp_dir/files.list"
    local file_entries="$fixture_tmp_dir/files.ndjson"
    local files_json="$fixture_tmp_dir/files.json"
    local prepare_payload="$fixture_tmp_dir/prepare.json"
    local manifest_payload="$fixture_tmp_dir/manifest.json"
    local commit_payload="$fixture_tmp_dir/commit.json"
    local archive_path="$fixture_tmp_dir/archive.tar.gz"

    (
        cd "$source_directory"
        find . -path './.vm0' -prune -o -type f -printf '%P\0' | LC_ALL=C sort -z > "$file_list"
    )

    : > "$file_entries"
    local file_path relative_path hash size
    while IFS= read -r -d '' file_path; do
        relative_path="${file_path#./}"
        hash="$(sha256sum -- "$source_directory/$relative_path" | cut -d ' ' -f 1)"
        size="$(stat -c '%s' -- "$source_directory/$relative_path")"
        jq -nc \
            --arg path "$relative_path" \
            --arg hash "$hash" \
            --argjson size "$size" \
            '{path: $path, hash: $hash, size: $size}' >> "$file_entries"
    done < "$file_list"
    jq -s '.' "$file_entries" > "$files_json"

    jq -n \
        --arg storageName "$storage_name" \
        --arg storageOwner "$storage_owner" \
        --slurpfile files "$files_json" \
        '{storageName: $storageName, storageOwner: $storageOwner, files: $files[0]}' > "$prepare_payload"

    local prepare_response version_id existing
    if ! prepare_response="$(e2e_api_curl "/api/test/storage-fixture/prepare" -X POST --data-binary "@$prepare_payload")"; then
        echo "# Storage fixture prepare request failed" >&2
        return 1
    fi
    version_id="$(jq -er '.versionId | select(length > 0)' <<< "$prepare_response")"
    existing="$(jq -r '.existing' <<< "$prepare_response")"

    if [[ "$existing" == "false" ]]; then
        local created_at archive_url manifest_url file_count
        created_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
        archive_url="$(jq -er '.uploads.archive.presignedUrl' <<< "$prepare_response")"
        manifest_url="$(jq -er '.uploads.manifest.presignedUrl' <<< "$prepare_response")"
        file_count="$(jq -r 'length' "$files_json")"

        if (( file_count > 0 )); then
            tar \
                --null \
                --create \
                --gzip \
                --file="$archive_path" \
                --directory="$source_directory" \
                --files-from="$file_list"
            if ! curl -fsS \
                --retry 2 \
                --retry-delay 1 \
                -X PUT \
                -H "Content-Type: application/gzip" \
                --upload-file "$archive_path" \
                "$archive_url"; then
                echo "# Storage fixture archive upload failed" >&2
                return 1
            fi
        fi

        jq -n \
            --arg createdAt "$created_at" \
            --slurpfile files "$files_json" \
            '{version: 1, files: $files[0], createdAt: $createdAt}' > "$manifest_payload"
        if ! curl -fsS \
            --retry 2 \
            --retry-delay 1 \
            -X PUT \
            -H "Content-Type: application/json" \
            --data-binary "@$manifest_payload" \
            "$manifest_url"; then
            echo "# Storage fixture manifest upload failed" >&2
            return 1
        fi
    fi

    jq -n \
        --arg storageName "$storage_name" \
        --arg storageOwner "$storage_owner" \
        --arg versionId "$version_id" \
        --slurpfile files "$files_json" \
        '{storageName: $storageName, storageOwner: $storageOwner, versionId: $versionId, files: $files[0]}' > "$commit_payload"

    local commit_response
    if ! commit_response="$(e2e_api_curl "/api/test/storage-fixture/commit" -X POST --data-binary "@$commit_payload")"; then
        echo "# Storage fixture commit request failed" >&2
        return 1
    fi
    if ! jq -e --arg versionId "$version_id" '
        .success == true
        and .versionId == $versionId
        and .headVersionId == $versionId
    ' <<< "$commit_response" >/dev/null; then
        echo "# Storage fixture commit did not acknowledge HEAD $version_id" >&2
        jq -c '{success, versionId, headVersionId}' <<< "$commit_response" >&2 || true
        return 1
    fi
    printf '%s\n' "$version_id"
)
