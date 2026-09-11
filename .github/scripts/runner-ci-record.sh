#!/usr/bin/env bash
set -euo pipefail

# Private transport for Runner CI manifests. A content hash checks integrity;
# the successful GitHub job step carrying that hash establishes its producer.
RUNNER_CI_RECORD_MAX_BYTES=65536
RUNNER_CI_RECORD_MAX_AGE_SECONDS=$((7 * 86400))

runner_ci_config() {
  : "${REPO:=${GITHUB_REPOSITORY:-}}"
  : "${REPO:?missing REPO}"
  : "${R2_ACCOUNT_ID:?missing R2_ACCOUNT_ID}"
  : "${R2_BUCKET_NAME:?missing R2_BUCKET_NAME}"
  : "${AWS_ACCESS_KEY_ID:?missing AWS_ACCESS_KEY_ID}"
  : "${AWS_SECRET_ACCESS_KEY:?missing AWS_SECRET_ACCESS_KEY}"
  [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 2
  RUNNER_CI_RECORD_PREFIX="runner-ci/v1/${REPO}/"
}

runner_ci_aws() {
  # Bound the whole client process, including SDK retries. Cache planning has
  # its own shorter owner deadline; required transfers get at most 120s.
  local seconds=120
  if [ -n "${RUNNER_CI_DEADLINE:-}" ]; then
    local remaining=$((RUNNER_CI_DEADLINE - $(date +%s)))
    [ "$remaining" -gt 0 ] || return 124
    if [ "$remaining" -lt "$seconds" ]; then seconds=$remaining; fi
  fi
  timeout --kill-after=5s "${seconds}s" env AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=3 \
    aws s3api "$@" --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --bucket "$R2_BUCKET_NAME" --cli-connect-timeout 5 --cli-read-timeout 30
}

runner_ci_record_name_valid() {
  [[ "$1" =~ ^runner-(binary-asset|image-manifest)-[A-Za-z0-9_-]+$ ]]
}

runner_ci_record_key_valid() {
  local key=$1 suffix
  [[ "$key" == "$RUNNER_CI_RECORD_PREFIX"* ]] || return 1
  suffix=${key#"$RUNNER_CI_RECORD_PREFIX"}
  [[ "$suffix" =~ ^(runner-(binary-asset|image-manifest)-[A-Za-z0-9_-]+)/([1-9][0-9]*)/([1-9][0-9]*)/([0-9a-f]{64})\.json$ ]]
}

runner_ci_record_get() {
  local key=$1 destination=$2 expected_sha actual_sha size
  runner_ci_record_key_valid "$key" || return 2
  expected_sha=${key##*/}
  expected_sha=${expected_sha%.json}
  runner_ci_aws get-object --key "$key" \
    --range "bytes=0-${RUNNER_CI_RECORD_MAX_BYTES}" "$destination" >/dev/null || return $?
  size=$(stat -c '%s' "$destination")
  [ "$size" -le "$RUNNER_CI_RECORD_MAX_BYTES" ] || return 1
  actual_sha=$(sha256sum "$destination" | awk '{print $1}')
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "Runner CI record SHA mismatch: ${key}" >&2
    return 1
  fi
  jq empty "$destination"
}

runner_ci_record_publish() {
  local name=$1 manifest=$2 run_id=$3 attempt=$4 size sha key status=0
  runner_ci_config
  runner_ci_record_name_valid "$name" || return 2
  [[ "$run_id" =~ ^[1-9][0-9]*$ && "$attempt" =~ ^[1-9][0-9]*$ ]] || return 2
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 2
  size=$(stat -c '%s' "$manifest")
  [ "$size" -gt 0 ] && [ "$size" -le "$RUNNER_CI_RECORD_MAX_BYTES" ] || return 2
  jq empty "$manifest" || return $?
  sha=$(sha256sum "$manifest" | awk '{print $1}')
  key="${RUNNER_CI_RECORD_PREFIX}${name}/${run_id}/${attempt}/${sha}.json"
  local error_file retained
  error_file=$(mktemp "${manifest}.put.XXXXXX")
  retained=$(mktemp "${manifest}.retained.XXXXXX")
  runner_ci_aws put-object --key "$key" --body "$manifest" \
    --content-type application/json --cache-control 'private, no-store' \
    --if-none-match '*' >/dev/null 2>"$error_file" || status=$?
  if [ "$status" -ne 0 ] && ! grep -q 'PreconditionFailed' "$error_file"; then
    echo "Runner CI record publication failed: name=${name} status=${status}" >&2
    rm -f "$error_file" "$retained"
    return "$status"
  fi
  status=0
  runner_ci_record_get "$key" "$retained" || status=$?
  rm -f "$error_file" "$retained"
  [ "$status" -eq 0 ] || return "$status"
  printf 'record-sha=%s\n' "$sha"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'record-sha=%s\n' "$sha" >>"$GITHUB_OUTPUT"
  fi
}

runner_ci_records() {
  local name=$1 run_id=${2:-} prefix json
  runner_ci_record_name_valid "$name" || return 2
  prefix="${RUNNER_CI_RECORD_PREFIX}${name}/"
  if [ -n "$run_id" ]; then
    [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || return 2
    prefix+="${run_id}/"
  fi
  json=$(runner_ci_aws list-objects-v2 --prefix "$prefix" --max-items 1000 --output json) || return $?
  # Do not turn a truncated index into a trusted, conflict-free candidate set.
  jq -ce --arg prefix "$prefix" --argjson max "$RUNNER_CI_RECORD_MAX_BYTES" '
    select(.NextToken == null) |
    [.Contents[]? | select(.Key | startswith($prefix)) |
      select(.Size > 0 and .Size <= $max)] | sort_by(.LastModified) | reverse
  ' <<<"$json"
}

runner_ci_record_fresh() {
  local modified=$1 timestamp now
  timestamp=$(date -d "$modified" +%s 2>/dev/null) || return 1
  now=$(date +%s)
  [ "$timestamp" -le "$now" ] && [ "$timestamp" -gt "$((now - RUNNER_CI_RECORD_MAX_AGE_SECONDS))" ]
}

runner_ci_jobs() {
  local run_id=$1
  timeout --kill-after=5s 60s gh api --paginate --slurp \
    "repos/${REPO}/actions/runs/${run_id}/jobs?filter=all&per_page=100"
}

runner_ci_receipt_valid() {
  local jobs=$1 run_id=$2 attempt=$3 sha=$4 now
  now=$(date +%s)
  # A failed-only rerun can retain a successful producer from an older attempt.
  # But once that job is rerun, its older receipt cannot authorize new readers.
  jq -e --argjson run "$run_id" --argjson attempt "$attempt" --arg name "R2 record ${sha}" \
    --argjson now "$now" --argjson age "$RUNNER_CI_RECORD_MAX_AGE_SECONDS" '
    [.[].jobs[] | select(.run_id == $run)] |
    group_by(.name) | map(max_by([.run_attempt, .id])) |
    any(.[];
      .run_attempt == $attempt and
      any(.steps[]?; .name == $name and .status == "completed" and .conclusion == "success" and
        # Storage timestamps can be refreshed by a writer; only GitHub can
        # establish when this producer actually acknowledged the record.
        ((.completed_at | fromdateiso8601?) as $time | $time <= $now and $time > ($now - $age)))
    )
  ' <<<"$jobs" >/dev/null
}

runner_ci_record_fetch() {
  local name=$1 run_id=$2 jobs=$3 destination=$4 records record key suffix attempt sha modified
  records=$(runner_ci_records "$name" "$run_id") || return $?
  while IFS= read -r record; do
    key=$(jq -r '.Key' <<<"$record")
    modified=$(jq -r '.LastModified' <<<"$record")
    runner_ci_record_key_valid "$key" || continue
    runner_ci_record_fresh "$modified" || continue
    suffix=${key#"${RUNNER_CI_RECORD_PREFIX}${name}/${run_id}/"}
    attempt=${suffix%%/*}
    sha=${suffix##*/}
    sha=${sha%.json}
    if runner_ci_receipt_valid "$jobs" "$run_id" "$attempt" "$sha"; then
      export RUNNER_CI_RECORD_ATTEMPT=$attempt
      runner_ci_record_get "$key" "$destination"
      return $?
    fi
  done < <(jq -c '.[]' <<<"$records")
  return 1
}

runner_ci_record_cleanup() {
  runner_ci_config
  case "${DRY_RUN:-false}" in true|false) ;; *) return 2 ;; esac
  local listing record key modified timestamp cutoff count=0 token=""
  local -a pagination=()
  cutoff=$(($(date +%s) - 14 * 86400))
  CLEANUP_TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$CLEANUP_TEMP_DIR"' EXIT
  local keys="${CLEANUP_TEMP_DIR}/keys" payload="${CLEANUP_TEMP_DIR}/delete.json" result
  : >"$keys"
  while true; do
    listing=$(runner_ci_aws list-objects-v2 --prefix "$RUNNER_CI_RECORD_PREFIX" \
      --no-paginate --max-keys 1000 "${pagination[@]}" --output json) || return $?
    while IFS= read -r record; do
      key=$(jq -r '.Key' <<<"$record")
      runner_ci_record_key_valid "$key" || continue
      modified=$(jq -r '.LastModified' <<<"$record")
      timestamp=$(date -d "$modified" +%s) || return $?
      [ "$timestamp" -lt "$cutoff" ] || continue
      printf '%s\n' "$key" >>"$keys"
      count=$((count + 1))
      [ "$count" -lt 1000 ] || break 2
    done < <(jq -c '.Contents[]?' <<<"$listing")
    token=$(jq -er 'if .IsTruncated then .NextContinuationToken | select(type == "string" and length > 0) else "" end' <<<"$listing") || return $?
    [ -n "$token" ] || break
    pagination=(--continuation-token "$token")
  done
  if [ "$count" -gt 0 ]; then
    if [ "${DRY_RUN:-false}" = true ]; then
      sed 's/^/Would delete expired Runner CI record: /' "$keys"
    else
      # One bounded S3 batch avoids a client startup/network round trip per key.
      jq -Rn '{Objects:[inputs | {Key:.}],Quiet:true}' <"$keys" >"$payload"
      result=$(runner_ci_aws delete-objects --delete "file://${payload}" --output json) || return $?
      if ! jq -e '(.Errors // [] | length) == 0' <<<"$result" >/dev/null; then
        echo "Runner CI record cleanup had per-object failures: ${result}" >&2
        return 1
      fi
      echo "Deleted expired Runner CI records: ${count}"
    fi
  fi
  echo "Expired Runner CI records processed: ${count}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  runner_ci_config
  case "${1:-}" in
    publish)
      runner_ci_record_publish "${RECORD_NAME:?}" "${MANIFEST_PATH:?}" \
        "${PRODUCER_RUN_ID:?}" "${PRODUCER_RUN_ATTEMPT:?}"
      ;;
    fetch)
      jobs=$(runner_ci_jobs "${PRODUCER_RUN_ID:?}")
      runner_ci_record_fetch "${RECORD_NAME:?}" "$PRODUCER_RUN_ID" "$jobs" "${MANIFEST_PATH:?}"
      ;;
    cleanup) runner_ci_record_cleanup ;;
    *) echo 'Usage: runner-ci-record.sh <publish|fetch|cleanup>' >&2; exit 2 ;;
  esac
fi
