#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 <r2-endpoint> <artifact-uri> <destination-directory>" >&2
  exit 1
fi

r2_endpoint="$1"
artifact_uri="${2%/}"
destination="$3"
max_attempts="${OKOU_DESKTOP_ARTIFACT_FETCH_ATTEMPTS:-3}"
retry_delay_seconds="${OKOU_DESKTOP_ARTIFACT_FETCH_RETRY_DELAY_SECONDS:-5}"

if [[ ! -d "$destination" ]]; then
  echo "Destination directory must exist: $destination" >&2
  exit 1
fi

error_log="$(mktemp)"
trap 'rm -f "$error_log"' EXIT

copy_with_retry() {
  local source_uri="$1"
  local destination_path="$2"
  local attempt=1

  while true; do
    if aws s3 cp \
      "$source_uri" \
      "$destination_path" \
      --endpoint-url "$r2_endpoint" \
      --only-show-errors 2>"$error_log"; then
      return 0
    fi
    if grep -Eq '404|NotFound|Not Found|NoSuchKey' "$error_log"; then
      cat "$error_log" >&2
      return 1
    fi
    if (( attempt >= max_attempts )); then
      cat "$error_log" >&2
      return 1
    fi
    echo "::warning::R2 copy of $source_uri failed, retrying ($((attempt + 1))/${max_attempts})"
    cat "$error_log" >&2
    attempt=$((attempt + 1))
    sleep "$retry_delay_seconds"
  done
}

for filename in manifest.json ready.json; do
  if ! copy_with_retry \
    "$artifact_uri/$filename" \
    "$destination/$filename"; then
    echo "Desktop artifact download failed: $artifact_uri/$filename" >&2
    exit 1
  fi
done

okou_archive_path="$(jq -r '.okouArchive.path // ""' "$destination/manifest.json")"
if [[ "$okou_archive_path" != "okou-app.tar.gz" ]]; then
  echo "Desktop artifact manifest contains an unexpected Okou archive path: ${okou_archive_path:-<missing>}" >&2
  exit 1
fi
if ! copy_with_retry \
  "$artifact_uri/$okou_archive_path" \
  "$destination/$okou_archive_path"; then
  echo "Desktop artifact download failed: $artifact_uri/$okou_archive_path" >&2
  exit 1
fi
