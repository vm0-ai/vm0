#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"
. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${SCRIPT_DIR}/runner-ci-record.sh"
. "${REPO_ROOT}/.github/scripts/runner-binary-build/contract.env"

RUNNER_BINARY_MAX_SIZE_BYTES=$((128 * 1024 * 1024))
RUNNER_BINARY_MAX_COMPRESSED_BYTES=$((64 * 1024 * 1024))
RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS=8
RUNNER_BINARY_MAX_TRUSTED_IDENTITIES=2
RUNNER_BINARY_WORKFLOW_PATH=".github/workflows/runner-image.yml"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

guest_keys_json() {
  runner_guest_binaries_load
  printf '%s\n' "${RUNNER_GUEST_BINARIES[@]}" | jq -Rsc 'split("\n")[:-1] | sort'
}

load_fresh() {
  require_env FRESH_METADATA_PATH
  require_env RUNNER_PATH
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST

  local expected_target_input="${EXPECTED_TARGET:-}"
  local expected_digest_input="${EXPECTED_BINARY_INPUT_DIGEST:-}"
  runner_image_validate_target "$expected_target_input"
  if [[ ! "$expected_digest_input" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid expected runner binary input digest: ${expected_digest_input}" >&2
    return 1
  fi
  if [ ! -f "$FRESH_METADATA_PATH" ] || [ -L "$FRESH_METADATA_PATH" ]; then
    echo "fresh runner metadata is not a regular file: ${FRESH_METADATA_PATH}" >&2
    return 1
  fi
  if [ ! -f "$RUNNER_PATH" ] || [ -L "$RUNNER_PATH" ]; then
    echo "fresh runner is not a regular file: ${RUNNER_PATH}" >&2
    return 1
  fi

  local expected_guests
  expected_guests=$(guest_keys_json)
  if ! jq -e \
    --arg digest "$expected_digest_input" \
    --arg target "$expected_target_input" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --argjson guests "$expected_guests" \
    --argjson max_size "$RUNNER_BINARY_MAX_SIZE_BYTES" '
      (keys | sort) == [
        "binaryInputDigest", "guestSha256", "runnerSha256",
        "runnerSizeBytes", "schemaVersion", "target", "toolchainImage"
      ] and
      .schemaVersion == 1 and
      .binaryInputDigest == $digest and
      .target == $target and
      .toolchainImage == $toolchain and
      (.runnerSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.runnerSizeBytes | type == "number" and floor == . and . > 0 and . <= $max_size) and
      (.guestSha256 | type == "object") and
      ((.guestSha256 | keys | sort) == $guests) and
      all(.guestSha256[]; type == "string" and test("^[0-9a-f]{64}$"))
    ' "$FRESH_METADATA_PATH" >/dev/null; then
    echo "invalid fresh runner metadata: ${FRESH_METADATA_PATH}" >&2
    return 1
  fi

  FRESH_BINARY_INPUT_DIGEST=$(jq -r '.binaryInputDigest' "$FRESH_METADATA_PATH")
  FRESH_TARGET=$(jq -r '.target' "$FRESH_METADATA_PATH")
  FRESH_RUNNER_SHA=$(jq -r '.runnerSha256' "$FRESH_METADATA_PATH")
  FRESH_RUNNER_SIZE=$(jq -r '.runnerSizeBytes' "$FRESH_METADATA_PATH")
  FRESH_GUESTS=$(jq -cS '.guestSha256' "$FRESH_METADATA_PATH")

  local actual_size actual_sha
  actual_size=$(stat -c '%s' "$RUNNER_PATH")
  actual_sha=$(sha256sum "$RUNNER_PATH" | awk '{print $1}')
  if [ "$actual_size" != "$FRESH_RUNNER_SIZE" ]; then
    echo "fresh runner size mismatch: ${actual_size} != ${FRESH_RUNNER_SIZE}" >&2
    return 1
  fi
  if [ "$actual_sha" != "$FRESH_RUNNER_SHA" ]; then
    echo "fresh runner sha mismatch: ${actual_sha} != ${FRESH_RUNNER_SHA}" >&2
    return 1
  fi
}

fresh_validate() {
  load_fresh
  emit "binary-input-digest" "$FRESH_BINARY_INPUT_DIGEST"
  emit "runner-sha" "$FRESH_RUNNER_SHA"
  emit "runner-size-bytes" "$FRESH_RUNNER_SIZE"
  emit "guest-sha-json" "$FRESH_GUESTS"
}

validate_reusable_manifest() {
  require_env MANIFEST_PATH
  local manifest_path_input="${MANIFEST_PATH:-}"
  if [ ! -f "$manifest_path_input" ] || [ -L "$manifest_path_input" ]; then
    echo "reusable runner manifest is not a regular file: ${manifest_path_input}" >&2
    return 1
  fi

  local expected_guests expected_target expected_digest expected_repository expected_workflow
  expected_guests=$(guest_keys_json)
  expected_target="${EXPECTED_TARGET:-}"
  expected_digest="${EXPECTED_BINARY_INPUT_DIGEST:-}"
  expected_repository="${EXPECTED_REPOSITORY:-}"
  expected_workflow="${EXPECTED_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}"

  if ! jq -e \
    --arg expected_target "$expected_target" \
    --arg expected_digest "$expected_digest" \
    --arg expected_toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --arg expected_repository "$expected_repository" \
    --arg expected_workflow "$expected_workflow" \
    --argjson guest_keys "$expected_guests" \
    --argjson max_runner_size "$RUNNER_BINARY_MAX_SIZE_BYTES" \
    --argjson max_compressed_size "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" '
      (keys | sort) == [
        "binaryInputDigest", "createdAt", "guests", "object", "producer",
        "runner", "schemaVersion", "target", "toolchainImage"
      ] and
      .schemaVersion == 1 and
      (.binaryInputDigest | type == "string" and test("^[0-9a-f]{64}$")) and
      ($expected_digest == "" or .binaryInputDigest == $expected_digest) and
      (.target == "aarch64-unknown-linux-musl" or .target == "x86_64-unknown-linux-musl") and
      ($expected_target == "" or .target == $expected_target) and
      .toolchainImage == $expected_toolchain and
      (.runner | type == "object") and
      ((.runner | keys | sort) == ["sha256", "sizeBytes"]) and
      (.runner.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.runner.sizeBytes | type == "number" and floor == . and . > 0 and . <= $max_runner_size) and
      (.guests | type == "object") and
      ((.guests | keys | sort) == $guest_keys) and
      all(.guests[]; type == "string" and test("^[0-9a-f]{64}$")) and
      (.object | type == "object") and
      ((.object | keys | sort) == ["compression", "key", "sizeBytes"]) and
      .object.compression == "zstd" and
      (.object.sizeBytes | type == "number" and floor == . and . > 0 and . <= $max_compressed_size) and
      .object.key == ("runner-binaries/" + .target + "/" + .runner.sha256 + ".zst") and
      (.producer | type == "object") and
      ((.producer | keys | sort) == [
        "event", "headSha", "prNumber", "repository", "runAttempt", "runId", "workflowPath"
      ]) and
      (.producer.repository | type == "string" and length > 0) and
      ($expected_repository == "" or .producer.repository == $expected_repository) and
      .producer.workflowPath == $expected_workflow and
      (.producer.runId | type == "number" and floor == . and . > 0) and
      (.producer.runAttempt | type == "number" and floor == . and . > 0) and
      (.producer.event == "push" or .producer.event == "pull_request" or .producer.event == "merge_group") and
      (.producer.headSha | type == "string" and test("^[0-9a-f]{40}$")) and
      (if .producer.event == "push" then
        .producer.prNumber == null
      else
        (.producer.prNumber | type == "number" and floor == . and . > 0)
      end) and
      (.createdAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' "$manifest_path_input" >/dev/null; then
    echo "invalid reusable runner manifest: ${manifest_path_input}" >&2
    return 1
  fi

  REUSABLE_BINARY_INPUT_DIGEST=$(jq -r '.binaryInputDigest' "$manifest_path_input")
  REUSABLE_RUNNER_SHA=$(jq -r '.runner.sha256' "$manifest_path_input")
  REUSABLE_RUNNER_SIZE=$(jq -r '.runner.sizeBytes' "$manifest_path_input")
  REUSABLE_OBJECT_KEY=$(jq -r '.object.key' "$manifest_path_input")
  REUSABLE_OBJECT_SIZE=$(jq -r '.object.sizeBytes' "$manifest_path_input")
}

manifest_validate() {
  validate_reusable_manifest
  emit "binary-input-digest" "$REUSABLE_BINARY_INPUT_DIGEST"
  emit "runner-sha" "$REUSABLE_RUNNER_SHA"
  emit "runner-size-bytes" "$REUSABLE_RUNNER_SIZE"
  emit "object-key" "$REUSABLE_OBJECT_KEY"
  emit "object-size-bytes" "$REUSABLE_OBJECT_SIZE"
}

reusable_record_name() {
  local target=$1 digest=$2
  printf 'runner-binary-asset-%s-%s\n' "$target" "$digest"
}

record_name() {
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST
  runner_image_validate_target "$EXPECTED_TARGET"
  if [[ ! "$EXPECTED_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid runner binary input digest: ${EXPECTED_BINARY_INPUT_DIGEST}" >&2
    exit 2
  fi
  emit "record-name" "$(reusable_record_name "$EXPECTED_TARGET" "$EXPECTED_BINARY_INPUT_DIGEST")"
}

publish_failure() {
  local reason=$1 message=$2
  echo "::error::Runner binary publication failed (${reason}): ${message}" >&2
  return 1
}

fetch_verified_r2_runner() {
  local object_key=$1
  local expected_object_size=$2
  local expected_runner_size=$3
  local expected_runner_sha=$4
  local compressed_path=$5
  local verified_runner_path=$6
  local head_json observed_object_size downloaded_size decompressed_size actual_sha
  local get_status=0 decompress_status=0
  local aws_error_log="${compressed_path}.aws.err"
  local zstd_error_log="${compressed_path}.zstd.err"

  R2_VERIFICATION_REASON=""
  R2_VERIFICATION_MESSAGE=""
  R2_VERIFIED_OBJECT_SIZE=""
  if ! head_json=$(runner_ci_aws head-object \
    --key "$object_key" \
    --output json 2>"$aws_error_log"); then
    R2_VERIFICATION_REASON="head-failed"
    R2_VERIFICATION_MESSAGE="the R2 object could not be inspected"
    return 1
  fi
  if ! observed_object_size=$(jq -er '.ContentLength | select(type == "number" and floor == .)' \
    <<<"$head_json" 2>/dev/null); then
    R2_VERIFICATION_REASON="head-malformed"
    R2_VERIFICATION_MESSAGE="the R2 object metadata was malformed"
    return 1
  fi
  if [[ ! "$observed_object_size" =~ ^[1-9][0-9]*$ ]] ||
    [ "$observed_object_size" -gt "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" ]; then
    R2_VERIFICATION_REASON="size-mismatch"
    R2_VERIFICATION_MESSAGE="the R2 object is outside the configured bound"
    return 1
  fi
  if [ -n "$expected_object_size" ] && [ "$observed_object_size" != "$expected_object_size" ]; then
    R2_VERIFICATION_REASON="size-mismatch"
    R2_VERIFICATION_MESSAGE="the R2 object size does not match the reusable manifest"
    return 1
  fi

  runner_ci_aws get-object \
    --key "$object_key" \
    --range "bytes=0-${RUNNER_BINARY_MAX_COMPRESSED_BYTES}" \
    "$compressed_path" \
    >/dev/null 2>"$aws_error_log" || get_status=$?
  if [ "$get_status" -ne 0 ]; then
    R2_VERIFICATION_REASON="get-failed"
    R2_VERIFICATION_MESSAGE="the R2 object could not be downloaded"
    return 1
  fi
  downloaded_size=$(stat -c '%s' "$compressed_path")
  if [ "$downloaded_size" != "$observed_object_size" ]; then
    R2_VERIFICATION_REASON="size-changed"
    R2_VERIFICATION_MESSAGE="the R2 object changed during validation"
    return 1
  fi

  zstd -q -d -c "$compressed_path" \
    2>"$zstd_error_log" \
    | head -c "$((RUNNER_BINARY_MAX_SIZE_BYTES + 1))" \
      > "$verified_runner_path" || decompress_status=$?
  decompressed_size=$(stat -c '%s' "$verified_runner_path")
  if [ "$decompress_status" -ne 0 ] ||
    [ "$decompressed_size" -gt "$RUNNER_BINARY_MAX_SIZE_BYTES" ]; then
    R2_VERIFICATION_REASON="decompression-invalid"
    R2_VERIFICATION_MESSAGE="the R2 object is not a bounded zstd runner"
    return 1
  fi
  actual_sha=$(sha256sum "$verified_runner_path" | awk '{print $1}')
  if [ "$decompressed_size" != "$expected_runner_size" ] ||
    [ "$actual_sha" != "$expected_runner_sha" ]; then
    R2_VERIFICATION_REASON="content-mismatch"
    R2_VERIFICATION_MESSAGE="the R2 object does not match the expected runner identity"
    return 1
  fi

  R2_VERIFIED_OBJECT_SIZE="$observed_object_size"
}

validate_producer_inputs() {
  require_env PRODUCER_REPOSITORY
  require_env PRODUCER_RUN_ID
  require_env PRODUCER_RUN_ATTEMPT
  require_env PRODUCER_EVENT
  require_env PRODUCER_HEAD_SHA
  if [ "${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" != "$RUNNER_BINARY_WORKFLOW_PATH" ]; then
    echo "unsupported producer workflow path: ${PRODUCER_WORKFLOW_PATH}" >&2
    return 1
  fi
  if [[ ! "$PRODUCER_RUN_ID" =~ ^[1-9][0-9]*$ ]] || [[ ! "$PRODUCER_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
    echo "invalid producer run identity" >&2
    return 1
  fi
  if [[ ! "$PRODUCER_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "invalid producer head SHA" >&2
    return 1
  fi
  case "$PRODUCER_EVENT" in
    push)
      if [ -n "${PRODUCER_PR_NUMBER:-}" ]; then
        echo "push producer must not have a PR number" >&2
        return 1
      fi
      ;;
    pull_request|merge_group)
      if [[ ! "${PRODUCER_PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
        echo "${PRODUCER_EVENT} producer requires a PR number" >&2
        return 1
      fi
      ;;
    *) echo "unsupported producer event: ${PRODUCER_EVENT}" >&2; return 1 ;;
  esac
}

publish() {
  load_fresh
  validate_producer_inputs
  require_env OUTPUT_DIR
  if [ "${OUTPUT_DIR:?}" = "/" ]; then
    echo "refusing unsafe OUTPUT_DIR=/" >&2
    exit 2
  fi
  mkdir -p "$OUTPUT_DIR"
  REPO=$PRODUCER_REPOSITORY

  if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET_NAME:-}" ] ||
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    publish_failure "missing-r2-config" "required R2 configuration is unavailable"
    return 1
  fi
  if ! command -v aws >/dev/null; then
    publish_failure "aws-unavailable" "AWS CLI is unavailable"
    return 1
  fi
  if ! command -v zstd >/dev/null; then
    publish_failure "zstd-unavailable" "zstd is unavailable"
    return 1
  fi

  local temp_root compressed retained decompressed error_log
  temp_root=$(mktemp -d "${RUNNER_TEMP:-${OUTPUT_DIR}}/runner-binary-publish.XXXXXX")
  compressed="${temp_root}/runner.zst"
  retained="${temp_root}/retained.zst"
  decompressed="${temp_root}/retained-runner"
  error_log="${temp_root}/aws.err"
  PUBLISH_TEMP_ROOT="$temp_root"
  trap 'rm -rf "$PUBLISH_TEMP_ROOT"' EXIT

  if ! zstd -q -3 -T0 -f -o "$compressed" "$RUNNER_PATH"; then
    publish_failure "compression-failed" "runner compression failed"
    return 1
  fi
  local compressed_size
  compressed_size=$(stat -c '%s' "$compressed")
  if [ "$compressed_size" -le 0 ] || [ "$compressed_size" -gt "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" ]; then
    publish_failure "compressed-size-invalid" "compressed runner is outside the configured bound"
    return 1
  fi

  local object_key put_status
  object_key="runner-binaries/${FRESH_TARGET}/${FRESH_RUNNER_SHA}.zst"
  runner_ci_config
  put_status=0
  runner_ci_aws put-object \
    --key "$object_key" \
    --body "$compressed" \
    --content-type application/zstd \
    --cache-control 'private, max-age=259200' \
    --if-none-match '*' \
    >/dev/null 2>"$error_log" || put_status=$?
  if [ "$put_status" -ne 0 ] && ! grep -Eq 'PreconditionFailed|precondition|412' "$error_log"; then
    publish_failure "put-failed" "R2 rejected the runner object upload"
    return 1
  fi

  local retained_size publish_reason
  if ! fetch_verified_r2_runner \
    "$object_key" "" "$FRESH_RUNNER_SIZE" "$FRESH_RUNNER_SHA" \
    "$retained" "$decompressed"; then
    case "$R2_VERIFICATION_REASON" in
      size-mismatch) publish_reason="retained-size-invalid" ;;
      size-changed) publish_reason="retained-size-changed" ;;
      content-mismatch) publish_reason="retained-content-mismatch" ;;
      *) publish_reason="$R2_VERIFICATION_REASON" ;;
    esac
    publish_failure "$publish_reason" "$R2_VERIFICATION_MESSAGE"
    return 1
  fi
  retained_size="$R2_VERIFIED_OBJECT_SIZE"

  local pr_number_json created_at manifest_tmp
  if [ -n "${PRODUCER_PR_NUMBER:-}" ]; then
    pr_number_json="$PRODUCER_PR_NUMBER"
  else
    pr_number_json="null"
  fi
  created_at=$(date -u +%FT%TZ)
  manifest_tmp="${OUTPUT_DIR}/manifest.json.tmp"
  jq -n \
    --arg binary_input_digest "$FRESH_BINARY_INPUT_DIGEST" \
    --arg target "$FRESH_TARGET" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --arg runner_sha "$FRESH_RUNNER_SHA" \
    --argjson runner_size "$FRESH_RUNNER_SIZE" \
    --argjson guests "$FRESH_GUESTS" \
    --arg key "$object_key" \
    --argjson object_size "$retained_size" \
    --arg repository "$PRODUCER_REPOSITORY" \
    --arg workflow_path "${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" \
    --argjson run_id "$PRODUCER_RUN_ID" \
    --argjson run_attempt "$PRODUCER_RUN_ATTEMPT" \
    --arg event "$PRODUCER_EVENT" \
    --arg head_sha "$PRODUCER_HEAD_SHA" \
    --argjson pr_number "$pr_number_json" \
    --arg created_at "$created_at" '
      {
        schemaVersion: 1,
        binaryInputDigest: $binary_input_digest,
        target: $target,
        toolchainImage: $toolchain,
        runner: {sha256: $runner_sha, sizeBytes: $runner_size},
        guests: $guests,
        object: {key: $key, compression: "zstd", sizeBytes: $object_size},
        producer: {
          repository: $repository,
          workflowPath: $workflow_path,
          runId: $run_id,
          runAttempt: $run_attempt,
          event: $event,
          headSha: $head_sha,
          prNumber: $pr_number
        },
        createdAt: $created_at
      }
    ' > "$manifest_tmp"
  mv -f "$manifest_tmp" "${OUTPUT_DIR}/manifest.json"

  env GITHUB_OUTPUT= \
    MANIFEST_PATH="${OUTPUT_DIR}/manifest.json" \
    EXPECTED_TARGET="$FRESH_TARGET" \
    EXPECTED_BINARY_INPUT_DIGEST="$FRESH_BINARY_INPUT_DIGEST" \
    EXPECTED_REPOSITORY="$PRODUCER_REPOSITORY" \
    EXPECTED_WORKFLOW_PATH="${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" \
    "$0" manifest-validate >/dev/null

  runner_ci_record_publish "$(reusable_record_name "$FRESH_TARGET" "$FRESH_BINARY_INPUT_DIGEST")" \
    "${OUTPUT_DIR}/manifest.json" "$PRODUCER_RUN_ID" "$PRODUCER_RUN_ATTEMPT"
  emit "published" "true"
  emit "publish-reason" "$([ "$put_status" -eq 0 ] && echo uploaded || echo existing-validated)"
  emit "manifest-path" "${OUTPUT_DIR}/manifest.json"
  emit "object-key" "$object_key"
  emit "object-size-bytes" "$retained_size"
}

shadow_result() {
  local outcome=$1 source=$2 reason=$3 run_id=${4:-}
  emit "shadow-outcome" "$outcome"
  emit "shadow-source" "$source"
  emit "shadow-reason" "$reason"
  emit "shadow-producer-run-id" "$run_id"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Runner binary shadow"
      echo
      echo "- Outcome: \`${outcome}\`"
      echo "- Source: \`${source:-none}\`"
      echo "- Reason: \`${reason}\`"
      if [ -n "$run_id" ]; then
        echo "- Producer run: \`${run_id}\`"
      fi
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

validate_resolution_context() {
  require_env REPO
  require_env CURRENT_RUN_ID
  require_env CURRENT_EVENT
  require_env DEFAULT_BRANCH
  case "$CURRENT_EVENT" in
    pull_request|merge_group)
      if [[ ! "${CURRENT_PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
        echo "${CURRENT_EVENT} runner binary resolution requires a current PR number" >&2
        exit 2
      fi
      ;;
    push) ;;
    *) echo "unsupported current event: ${CURRENT_EVENT}" >&2; exit 2 ;;
  esac
}

producer_is_main_reachable() {
  local ancestor_sha=$1 comparison_json
  if ! comparison_json=$(timeout --kill-after=5s 60s gh api \
    "repos/${REPO}/compare/${ancestor_sha}...${DEFAULT_BRANCH}" 2>/dev/null); then
    return 1
  fi
  jq -e \
    --arg producer_head_sha "$ancestor_sha" '
      (.base_commit | type == "object") and
      .base_commit.sha == $producer_head_sha and
      (.merge_base_commit | type == "object") and
      .merge_base_commit.sha == $producer_head_sha and
      (.ahead_by | type == "number" and floor == . and . >= 0) and
      (.behind_by | type == "number" and floor == . and . >= 0) and
      (
        (
          .status == "identical" and
          .ahead_by == 0 and
          .behind_by == 0
        ) or
        (
          .status == "ahead" and
          .ahead_by > 0 and
          .behind_by == 0
        )
      )
    ' <<<"$comparison_json" >/dev/null
}

collect_trusted_candidates() {
  local expected_target=$1 expected_digest=$2 output_dir=$3
  mkdir -p "$output_dir"
  runner_ci_config
  local name records
  name=$(reusable_record_name "$expected_target" "$expected_digest")
  if ! records=$(runner_ci_records "$name" 2>/dev/null); then
    CANDIDATE_DISCOVERY_REASON="record-index-unavailable"
    return 1
  fi

  local trusted_file="${output_dir}/trusted-candidates.tsv"
  local unsorted="${output_dir}/trusted-unsorted.tsv"
  local identities="${output_dir}/identities"
  : > "$trusted_file"
  : > "$unsorted"
  : > "$identities"
  local inspected=0 trusted_count=0 identity_count=0
  local record key suffix run_id attempt sha modified manifest_path run_json jobs_json
  local source event branch head producer_prs source_rank identity_key

  while IFS= read -r record; do
    [ "$inspected" -lt "$RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS" ] || break
    key=$(jq -r '.Key' <<<"$record")
    modified=$(jq -r '.LastModified' <<<"$record")
    runner_ci_record_key_valid "$key" || continue
    runner_ci_record_fresh "$modified" || continue
    suffix=${key#"${RUNNER_CI_RECORD_PREFIX}${name}/"}
    run_id=${suffix%%/*}
    suffix=${suffix#*/}
    attempt=${suffix%%/*}
    sha=${suffix##*/}
    sha=${sha%.json}
    [ "$run_id" != "$CURRENT_RUN_ID" ] || continue
    inspected=$((inspected + 1))

    run_json=$(timeout --kill-after=5s 60s gh api "repos/${REPO}/actions/runs/${run_id}" 2>/dev/null) || continue
    if ! jq -e --arg repo "$REPO" --arg workflow "$RUNNER_BINARY_WORKFLOW_PATH" \
      --argjson run "$run_id" --argjson attempt "$attempt" '
      .id == $run and .repository.full_name == $repo and .path == $workflow and
      .status == "completed" and .run_attempt >= $attempt and
      (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
    ' <<<"$run_json" >/dev/null; then
      continue
    fi
    event=$(jq -r '.event' <<<"$run_json")
    branch=$(jq -r '.head_branch' <<<"$run_json")
    head=$(jq -r '.head_sha' <<<"$run_json")
    source=""
    producer_prs='[]'
    case "$event" in
      push) [ "$branch" != "$DEFAULT_BRANCH" ] || source=protected-main ;;
      pull_request)
        producer_prs=$(jq -ce '[.pull_requests[]?.number] |
          select(length > 0 and all(.[]; type == "number" and floor == . and . > 0))' <<<"$run_json") || continue
        if [ -n "${CURRENT_PR_NUMBER:-}" ] &&
          jq -e --argjson pr "$CURRENT_PR_NUMBER" 'index($pr) != null' <<<"$producer_prs" >/dev/null; then
          source=same-pr
        fi
        ;;
      merge_group)
        [[ "$branch" =~ (^|/)pr-([1-9][0-9]*)- ]] || continue
        producer_prs="[${BASH_REMATCH[2]}]"
        [ "${BASH_REMATCH[2]}" != "${CURRENT_PR_NUMBER:-}" ] || source=same-pr
        ;;
      *) continue ;;
    esac
    if [ -z "$source" ]; then
      producer_is_main_reachable "$head" || continue
      source=main-reachable
    fi
    case "${CURRENT_EVENT}:${source}" in
      pull_request:protected-main|merge_group:same-pr|push:protected-main) source_rank=0 ;;
      pull_request:main-reachable|merge_group:protected-main|push:main-reachable) source_rank=1 ;;
      pull_request:same-pr|merge_group:main-reachable) source_rank=2 ;;
      *) continue ;;
    esac

    jobs_json=$(runner_ci_jobs "$run_id" 2>/dev/null) || continue
    runner_ci_receipt_valid "$jobs_json" "$run_id" "$attempt" "$sha" || continue
    manifest_path="${output_dir}/${sha}.json"
    runner_ci_record_get "$key" "$manifest_path" >/dev/null 2>&1 || continue
    if ! env GITHUB_OUTPUT= MANIFEST_PATH="$manifest_path" EXPECTED_TARGET="$expected_target" \
      EXPECTED_BINARY_INPUT_DIGEST="$expected_digest" EXPECTED_REPOSITORY="$REPO" \
      EXPECTED_WORKFLOW_PATH="$RUNNER_BINARY_WORKFLOW_PATH" "$0" manifest-validate >/dev/null 2>&1; then
      continue
    fi
    if ! jq -e --argjson run "$run_id" --argjson attempt "$attempt" --arg event "$event" \
      --arg head "$head" --argjson prs "$producer_prs" --arg source "$source" \
      --argjson current_pr "${CURRENT_PR_NUMBER:-null}" '
      .producer.runId == $run and .producer.runAttempt == $attempt and
      .producer.event == $event and .producer.headSha == $head and
      (if $event == "push" then .producer.prNumber == null
       else .producer.prNumber as $pr | ($prs | index($pr)) != null end) and
      ($source != "same-pr" or .producer.prNumber == $current_pr)
    ' "$manifest_path" >/dev/null; then
      continue
    fi
    identity_key=$(jq -cS '{runner, guests}' "$manifest_path" | sha256sum | awk '{print $1}')
    if ! grep -qxF "$identity_key" "$identities"; then
      printf '%s\n' "$identity_key" >> "$identities"
      identity_count=$((identity_count + 1))
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$source_rank" "$modified" "$sha" "$run_id" "$source" "$manifest_path" >> "$unsorted"
    trusted_count=$((trusted_count + 1))
    [ "$identity_count" -lt "$RUNNER_BINARY_MAX_TRUSTED_IDENTITIES" ] || break
  done < <(jq -c '.[]' <<<"$records")

  sort -t $'\t' -k1,1n -k2,2r "$unsorted" > "$trusted_file"
  TRUSTED_CANDIDATES_FILE="$trusted_file"
  TRUSTED_CANDIDATE_COUNT=$trusted_count
  TRUSTED_IDENTITY_COUNT=$identity_count
  TRUSTED_INSPECTION_COUNT=$inspected
  CANDIDATE_DISCOVERY_REASON=trusted-candidate
  if [ "$trusted_count" -eq 0 ]; then
    CANDIDATE_DISCOVERY_REASON=no-trusted-candidate
    if [ "$inspected" -ge "$RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS" ]; then
      CANDIDATE_DISCOVERY_REASON=candidate-limit-exhausted
    fi
  elif [ "$identity_count" -gt 1 ]; then
    CANDIDATE_DISCOVERY_REASON=trusted-output-conflict
  fi
}

first_trusted_candidate() {
  IFS=$'\t' read -r _ _ _ \
    TRUSTED_RUN_ID TRUSTED_SOURCE TRUSTED_MANIFEST_PATH < "$TRUSTED_CANDIDATES_FILE"
  [ -n "${TRUSTED_RUN_ID:-}" ]
}

shadow_resolve() {
  load_fresh
  require_env SHADOW_OUTPUT_DIR
  if [ "$SHADOW_OUTPUT_DIR" = "/" ]; then
    echo "refusing unsafe SHADOW_OUTPUT_DIR=/" >&2
    exit 2
  fi
  mkdir -p "$SHADOW_OUTPUT_DIR"
  validate_resolution_context

  if ! collect_trusted_candidates \
    "$FRESH_TARGET" "$FRESH_BINARY_INPUT_DIGEST" "$SHADOW_OUTPUT_DIR"; then
    shadow_result "error" "" "$CANDIDATE_DISCOVERY_REASON"
    return 0
  fi
  if [ "$TRUSTED_IDENTITY_COUNT" -gt 1 ]; then
    first_trusted_candidate
    shadow_result "conflict" "$TRUSTED_SOURCE" \
      "equal-input-output-mismatch" "$TRUSTED_RUN_ID"
    echo "equal runner binary input digest produced conflicting output identity: current run ${CURRENT_RUN_ID}, candidate run ${TRUSTED_RUN_ID}" >&2
    return 1
  fi
  if [ "$TRUSTED_CANDIDATE_COUNT" -eq 0 ]; then
    shadow_result "miss" "" "$CANDIDATE_DISCOVERY_REASON"
    return 0
  fi

  first_trusted_candidate
  local candidate_runner_sha candidate_runner_size candidate_guests
  candidate_runner_sha=$(jq -r '.runner.sha256' "$TRUSTED_MANIFEST_PATH")
  candidate_runner_size=$(jq -r '.runner.sizeBytes' "$TRUSTED_MANIFEST_PATH")
  candidate_guests=$(jq -cS '.guests' "$TRUSTED_MANIFEST_PATH")
  if [ "$candidate_runner_sha" != "$FRESH_RUNNER_SHA" ] ||
    [ "$candidate_runner_size" != "$FRESH_RUNNER_SIZE" ] ||
    [ "$candidate_guests" != "$FRESH_GUESTS" ]; then
    shadow_result "conflict" "$TRUSTED_SOURCE" \
      "equal-input-output-mismatch" "$TRUSTED_RUN_ID"
    echo "equal runner binary input digest produced conflicting output identity: current run ${CURRENT_RUN_ID}, candidate run ${TRUSTED_RUN_ID}" >&2
    return 1
  fi

  shadow_result "hit" "$TRUSTED_SOURCE" "equal-output" "$TRUSTED_RUN_ID"
}

resolve_result() {
  local outcome=$1 source=$2 reason=$3 run_id=${4:-}
  emit "resolve-outcome" "$outcome"
  emit "resolve-source" "$source"
  emit "resolve-reason" "$reason"
  emit "resolve-producer-run-id" "$run_id"
}

active_resolve() {
  local mode=${1:-download}
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST
  require_env RESOLVE_OUTPUT_DIR
  runner_image_validate_target "$EXPECTED_TARGET"
  if [[ ! "$EXPECTED_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid expected runner binary input digest: ${EXPECTED_BINARY_INPUT_DIGEST}" >&2
    exit 2
  fi
  if [ "$RESOLVE_OUTPUT_DIR" = "/" ] || [ -e "$RESOLVE_OUTPUT_DIR" ] || [ -L "$RESOLVE_OUTPUT_DIR" ]; then
    echo "runner binary resolve output already exists or is unsafe: ${RESOLVE_OUTPUT_DIR}" >&2
    exit 2
  fi
  validate_resolution_context

  case "${RUNNER_BINARY_CACHE_FORCE_MISS:-false}" in
    true)
      resolve_result "miss" "" "force-miss"
      return 0
      ;;
    false|"") ;;
    *)
      echo "invalid RUNNER_BINARY_CACHE_FORCE_MISS: ${RUNNER_BINARY_CACHE_FORCE_MISS}" >&2
      exit 2
      ;;
  esac
  if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET_NAME:-}" ] ||
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    resolve_result "miss" "" "missing-r2-config"
    return 0
  fi
  if ! command -v aws >/dev/null; then
    resolve_result "miss" "" "aws-unavailable"
    return 0
  fi
  if ! command -v zstd >/dev/null; then
    resolve_result "miss" "" "zstd-unavailable"
    return 0
  fi

  local output_parent temp_root candidate_dir
  output_parent=$(dirname "$RESOLVE_OUTPUT_DIR")
  mkdir -p "$output_parent"
  temp_root=$(mktemp -d "${RUNNER_TEMP:-${output_parent}}/runner-binary-resolve.XXXXXX")
  candidate_dir="${temp_root}/candidates"
  ACTIVE_RESOLVE_TEMP_ROOT="$temp_root"
  trap 'rm -rf "$ACTIVE_RESOLVE_TEMP_ROOT"' EXIT

  if ! collect_trusted_candidates \
    "$EXPECTED_TARGET" "$EXPECTED_BINARY_INPUT_DIGEST" "$candidate_dir"; then
    emit "candidate-inspections" "0"
    resolve_result "miss" "" "$CANDIDATE_DISCOVERY_REASON"
    return 0
  fi
  emit "candidate-inspections" "$TRUSTED_INSPECTION_COUNT"
  if [ "$TRUSTED_IDENTITY_COUNT" -gt 1 ]; then
    resolve_result "miss" "" "trusted-output-conflict"
    return 0
  fi
  if [ "$TRUSTED_CANDIDATE_COUNT" -eq 0 ]; then
    resolve_result "miss" "" "$CANDIDATE_DISCOVERY_REASON"
    return 0
  fi
  first_trusted_candidate

  if [ "$mode" = reference ]; then
    local head
    if ! head=$(runner_ci_aws head-object --key "$(jq -r '.object.key' "$TRUSTED_MANIFEST_PATH")" --output json 2>/dev/null) ||
      ! jq -e --argjson size "$(jq '.object.sizeBytes' "$TRUSTED_MANIFEST_PATH")" '.ContentLength == $size' <<<"$head" >/dev/null; then
      resolve_result miss "$TRUSTED_SOURCE" r2-head-failed "$TRUSTED_RUN_ID"
      return 0
    fi
    mkdir -p "$RESOLVE_OUTPUT_DIR"
    cp "$TRUSTED_MANIFEST_PATH" "${RESOLVE_OUTPUT_DIR}/manifest.json"
    emit "runner-size-bytes" "$(jq '.runner.sizeBytes' "$TRUSTED_MANIFEST_PATH")"
    emit "object-size-bytes" "$(jq '.object.sizeBytes' "$TRUSTED_MANIFEST_PATH")"
    resolve_result hit "$TRUSTED_SOURCE" reference "$TRUSTED_RUN_ID"
    return 0
  fi

  local object_key object_size runner_sha runner_size
  object_key=$(jq -r '.object.key' "$TRUSTED_MANIFEST_PATH")
  object_size=$(jq -r '.object.sizeBytes' "$TRUSTED_MANIFEST_PATH")
  runner_sha=$(jq -r '.runner.sha256' "$TRUSTED_MANIFEST_PATH")
  runner_size=$(jq -r '.runner.sizeBytes' "$TRUSTED_MANIFEST_PATH")
  local compressed decompressed
  compressed="${temp_root}/runner.zst"
  decompressed="${temp_root}/runner"
  if ! fetch_verified_r2_runner \
    "$object_key" "$object_size" "$runner_size" "$runner_sha" \
    "$compressed" "$decompressed"; then
    resolve_result "miss" "$TRUSTED_SOURCE" \
      "r2-${R2_VERIFICATION_REASON}" "$TRUSTED_RUN_ID"
    return 0
  fi

  local transport_dir
  transport_dir="${temp_root}/transport"
  mkdir -p "$transport_dir"
  install -m 755 "$decompressed" "${transport_dir}/runner"
  jq '{
    schemaVersion,
    binaryInputDigest,
    target,
    toolchainImage,
    runnerSha256: .runner.sha256,
    runnerSizeBytes: .runner.sizeBytes,
    guestSha256: .guests
  }' "$TRUSTED_MANIFEST_PATH" > "${transport_dir}/metadata.json"
  env GITHUB_OUTPUT= \
    FRESH_METADATA_PATH="${transport_dir}/metadata.json" \
    RUNNER_PATH="${transport_dir}/runner" \
    EXPECTED_TARGET="$EXPECTED_TARGET" \
    EXPECTED_BINARY_INPUT_DIGEST="$EXPECTED_BINARY_INPUT_DIGEST" \
    "$0" fresh-validate >/dev/null
  mv "$transport_dir" "$RESOLVE_OUTPUT_DIR"

  emit "runner-size-bytes" "$runner_size"
  emit "object-size-bytes" "$object_size"
  resolve_result "hit" "$TRUSTED_SOURCE" "validated" "$TRUSTED_RUN_ID"
}

download_manifest() {
  require_env MANIFEST_PATH
  require_env RESOLVE_OUTPUT_DIR
  validate_reusable_manifest
  runner_ci_config
  [ ! -e "$RESOLVE_OUTPUT_DIR" ] && [ ! -L "$RESOLVE_OUTPUT_DIR" ] || return 2
  local work_dir status=0
  mkdir -p "$(dirname "$RESOLVE_OUTPUT_DIR")"
  work_dir=$(mktemp -d "${RESOLVE_OUTPUT_DIR}.XXXXXX")
  if ! fetch_verified_r2_runner "$REUSABLE_OBJECT_KEY" "$REUSABLE_OBJECT_SIZE" \
    "$REUSABLE_RUNNER_SIZE" "$REUSABLE_RUNNER_SHA" "${work_dir}/runner.zst" "${work_dir}/runner"; then
    echo "::error::Required Runner binary retrieval failed: ${R2_VERIFICATION_REASON}" >&2
    rm -rf "$work_dir"
    return 1
  fi
  chmod 755 "${work_dir}/runner"
  jq '{schemaVersion, binaryInputDigest, target, toolchainImage,
    runnerSha256: .runner.sha256, runnerSizeBytes: .runner.sizeBytes, guestSha256: .guests
  }' "$MANIFEST_PATH" > "${work_dir}/metadata.json"
  env GITHUB_OUTPUT= FRESH_METADATA_PATH="${work_dir}/metadata.json" RUNNER_PATH="${work_dir}/runner" \
    "$0" fresh-validate >/dev/null || status=$?
  if [ "$status" -ne 0 ]; then rm -rf "$work_dir"; return "$status"; fi
  rm -f "${work_dir}/runner.zst" "${work_dir}/runner.zst.aws.err" "${work_dir}/runner.zst.zstd.err"
  mv "$work_dir" "$RESOLVE_OUTPUT_DIR"
}

download_current() {
  require_env CURRENT_RUN_ID
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST
  require_env EXPECTED_PRODUCER_HEAD_SHA
  runner_ci_config
  local run jobs name manifest status=0
  run=$(timeout --kill-after=5s 60s gh api "repos/${REPO}/actions/runs/${CURRENT_RUN_ID}")
  jq -e --arg repo "$REPO" --arg head "$EXPECTED_PRODUCER_HEAD_SHA" \
    --arg workflow "$RUNNER_BINARY_WORKFLOW_PATH" --argjson run "$CURRENT_RUN_ID" '
    .id == $run and .repository.full_name == $repo and .path == $workflow and .head_sha == $head
  ' <<<"$run" >/dev/null
  jobs=$(runner_ci_jobs "$CURRENT_RUN_ID")
  name=$(reusable_record_name "$EXPECTED_TARGET" "$EXPECTED_BINARY_INPUT_DIGEST")
  manifest=$(mktemp "${RUNNER_TEMP:-$(dirname "$RESOLVE_OUTPUT_DIR")}/runner-manifest.XXXXXX")
  if ! runner_ci_record_fetch "$name" "$CURRENT_RUN_ID" "$jobs" "$manifest"; then
    rm -f "$manifest"
    echo "::error::Current Runner binary has no authenticated R2 record" >&2
    return 1
  fi
  if ! jq -e --argjson run "$CURRENT_RUN_ID" --argjson attempt "$RUNNER_CI_RECORD_ATTEMPT" \
    --arg head "$EXPECTED_PRODUCER_HEAD_SHA" '
    .producer.runId == $run and .producer.runAttempt == $attempt and .producer.headSha == $head
  ' "$manifest" >/dev/null; then
    rm -f "$manifest"
    echo "::error::Current Runner binary record has inconsistent producer identity" >&2
    return 1
  fi
  MANIFEST_PATH="$manifest" EXPECTED_REPOSITORY="$REPO" download_manifest || status=$?
  rm -f "$manifest"
  return "$status"
}

usage() {
  cat <<'USAGE'
Usage: runner-binary-cache.sh <fresh-validate|record-name|manifest-validate|publish|shadow-resolve|active-resolve|reference-resolve|download|download-current>
USAGE
}

case "${1:-}" in
  fresh-validate) fresh_validate ;;
  record-name) record_name ;;
  manifest-validate) manifest_validate ;;
  publish) publish ;;
  shadow-resolve) shadow_resolve ;;
  active-resolve) active_resolve ;;
  reference-resolve) active_resolve reference ;;
  download) download_manifest ;;
  download-current) download_current ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
