#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <r2-endpoint> <artifact-uri> <destination-dir>" >&2
  exit 1
fi

r2_endpoint="$1"
artifact_uri="${2%/}"
destination="$3"
archive_uri="${artifact_uri}/dist.tar.gz"
max_attempts="${OKOU_ARTIFACT_FETCH_ATTEMPTS:-3}"
retry_delay_seconds="${OKOU_ARTIFACT_FETCH_RETRY_DELAY_SECONDS:-5}"

if [[ ! -d "$destination" ]]; then
  echo "destination directory must exist: $destination" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
archive_path="${work_dir}/dist.tar.gz"
error_log="${work_dir}/aws-error.log"

# R2 occasionally breaks a transfer mid-stream (IncompleteRead), which fails the
# whole copy. Every copy here is idempotent, so retry before giving up.
copy_with_retry() {
  local attempt=1
  while true; do
    if aws s3 cp "$@" \
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
    echo "::warning::R2 copy of $1 failed, retrying" \
      "($((attempt + 1))/${max_attempts})"
    cat "$error_log" >&2
    attempt=$((attempt + 1))
    sleep "$retry_delay_seconds"
  done
}

if ! copy_with_retry "$archive_uri" "$archive_path"; then
  echo "app artifact archive download failed: $archive_uri" >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$destination"

# manifest.json and ready.json stay outside the archive because ready.json is
# the marker that publishes the artifact and must be written last.
for metadata_file in manifest.json ready.json; do
  if ! copy_with_retry \
    "${artifact_uri}/${metadata_file}" \
    "${destination}/${metadata_file}"; then
    echo "app artifact metadata download failed: ${metadata_file}" >&2
    exit 1
  fi
done
