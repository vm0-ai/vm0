#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"
. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${REPO_ROOT}/.github/runner-binary-build/contract.env"

RUNNER_BINARY_MAX_SIZE_BYTES=$((128 * 1024 * 1024))
RUNNER_BINARY_MAX_COMPRESSED_BYTES=$((64 * 1024 * 1024))
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

artifact_name() {
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST
  runner_image_validate_target "$EXPECTED_TARGET"
  if [[ ! "$EXPECTED_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid runner binary input digest: ${EXPECTED_BINARY_INPUT_DIGEST}" >&2
    exit 2
  fi
  emit "artifact-name" "runner-binary-asset-${EXPECTED_TARGET}-${EXPECTED_BINARY_INPUT_DIGEST}"
}

publish_soft_failure() {
  local reason=$1 message=$2
  echo "::warning::Runner binary cache publication skipped (${reason}): ${message}"
  emit "published" "false"
  emit "publish-reason" "$reason"
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
  if [ "$OUTPUT_DIR" = "/" ]; then
    echo "refusing unsafe OUTPUT_DIR=/" >&2
    exit 2
  fi
  mkdir -p "$OUTPUT_DIR"

  if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET_NAME:-}" ] ||
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    publish_soft_failure "missing-r2-config" "required R2 configuration is unavailable"
    return 0
  fi
  if ! command -v aws >/dev/null; then
    publish_soft_failure "aws-unavailable" "AWS CLI is unavailable"
    return 0
  fi
  if ! command -v zstd >/dev/null; then
    publish_soft_failure "zstd-unavailable" "zstd is unavailable"
    return 0
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
    publish_soft_failure "compression-failed" "runner compression failed"
    return 0
  fi
  local compressed_size
  compressed_size=$(stat -c '%s' "$compressed")
  if [ "$compressed_size" -le 0 ] || [ "$compressed_size" -gt "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" ]; then
    publish_soft_failure "compressed-size-invalid" "compressed runner is outside the configured bound"
    return 0
  fi

  local object_key endpoint put_status
  object_key="runner-binaries/${FRESH_TARGET}/${FRESH_RUNNER_SHA}.zst"
  endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  put_status=0
  aws s3api put-object \
    --endpoint-url "$endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --body "$compressed" \
    --content-type application/zstd \
    --cache-control 'private, max-age=259200' \
    --if-none-match '*' \
    >/dev/null 2>"$error_log" || put_status=$?
  if [ "$put_status" -ne 0 ] && ! grep -Eq 'PreconditionFailed|precondition|412' "$error_log"; then
    publish_soft_failure "put-failed" "R2 rejected the runner object upload"
    return 0
  fi

  local head_json retained_size get_status
  if ! head_json=$(aws s3api head-object \
    --endpoint-url "$endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --output json 2>"$error_log"); then
    publish_soft_failure "head-failed" "the retained R2 object could not be inspected"
    return 0
  fi
  if ! retained_size=$(jq -er '.ContentLength | select(type == "number" and floor == .)' \
    <<<"$head_json" 2>/dev/null); then
    publish_soft_failure "head-malformed" "the retained R2 object metadata was malformed"
    return 0
  fi
  if [[ ! "$retained_size" =~ ^[1-9][0-9]*$ ]] || [ "$retained_size" -gt "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" ]; then
    publish_soft_failure "retained-size-invalid" "the retained R2 object is outside the configured bound"
    return 0
  fi

  get_status=0
  aws s3api get-object \
    --endpoint-url "$endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --range "bytes=0-${RUNNER_BINARY_MAX_COMPRESSED_BYTES}" \
    "$retained" \
    >/dev/null 2>"$error_log" || get_status=$?
  if [ "$get_status" -ne 0 ]; then
    publish_soft_failure "get-failed" "the retained R2 object could not be downloaded"
    return 0
  fi
  if [ "$(stat -c '%s' "$retained")" != "$retained_size" ]; then
    publish_soft_failure "retained-size-changed" "the retained R2 object changed during validation"
    return 0
  fi

  local decompress_status=0
  set +e
  set -o pipefail
  zstd -q -d -c "$retained" \
    2>"${temp_root}/zstd.err" \
    | head -c "$((RUNNER_BINARY_MAX_SIZE_BYTES + 1))" \
      > "$decompressed"
  decompress_status=$?
  set -e
  if [ "$decompress_status" -ne 0 ] || [ "$(stat -c '%s' "$decompressed")" -gt "$RUNNER_BINARY_MAX_SIZE_BYTES" ]; then
    publish_soft_failure "decompression-invalid" "the retained R2 object is not a bounded zstd runner"
    return 0
  fi
  if [ "$(stat -c '%s' "$decompressed")" != "$FRESH_RUNNER_SIZE" ] ||
    [ "$(sha256sum "$decompressed" | awk '{print $1}')" != "$FRESH_RUNNER_SHA" ]; then
    publish_soft_failure "retained-content-mismatch" "the retained R2 object does not match the fresh runner identity"
    return 0
  fi

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

  MANIFEST_PATH="${OUTPUT_DIR}/manifest.json" \
  EXPECTED_TARGET="$FRESH_TARGET" \
  EXPECTED_BINARY_INPUT_DIGEST="$FRESH_BINARY_INPUT_DIGEST" \
  EXPECTED_REPOSITORY="$PRODUCER_REPOSITORY" \
  EXPECTED_WORKFLOW_PATH="${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" \
    "$0" manifest-validate >/dev/null

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

shadow_resolve() {
  load_fresh
  require_env REPO
  require_env CURRENT_RUN_ID
  require_env CURRENT_EVENT
  require_env DEFAULT_BRANCH
  require_env SHADOW_OUTPUT_DIR
  if [ "$SHADOW_OUTPUT_DIR" = "/" ]; then
    echo "refusing unsafe SHADOW_OUTPUT_DIR=/" >&2
    exit 2
  fi
  case "$CURRENT_EVENT" in
    pull_request|merge_group)
      if [[ ! "${CURRENT_PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
        echo "${CURRENT_EVENT} shadow resolution requires a current PR number" >&2
        exit 2
      fi
      ;;
    push) ;;
    *) echo "unsupported current event: ${CURRENT_EVENT}" >&2; exit 2 ;;
  esac
  mkdir -p "$SHADOW_OUTPUT_DIR"

  local artifact_name_value artifacts_json
  artifact_name_value="runner-binary-asset-${FRESH_TARGET}-${FRESH_BINARY_INPUT_DIGEST}"
  if ! artifacts_json=$(gh api --paginate --slurp \
    "repos/${REPO}/actions/artifacts?name=${artifact_name_value}&per_page=100" 2>/dev/null); then
    shadow_result "error" "" "artifact-api-unavailable"
    return 0
  fi
  if ! jq -e 'type == "array" and all(.[]; type == "object" and (.artifacts | type == "array"))' \
    <<<"$artifacts_json" >/dev/null; then
    shadow_result "error" "" "artifact-api-malformed"
    return 0
  fi

  local candidates_file
  candidates_file="${SHADOW_OUTPUT_DIR}/trusted-candidates.tsv"
  : > "$candidates_file"
  while IFS= read -r artifact_encoded; do
    [ -n "$artifact_encoded" ] || continue
    local artifact_json artifact_run_id artifact_id artifact_created artifact_branch artifact_head_sha
    artifact_json=$(base64 -d <<<"$artifact_encoded")
    artifact_run_id=$(jq -r '.workflow_run.id // empty' <<<"$artifact_json")
    artifact_id=$(jq -r '.id // empty' <<<"$artifact_json")
    artifact_created=$(jq -r '.created_at // empty' <<<"$artifact_json")
    artifact_branch=$(jq -r '.workflow_run.head_branch // empty' <<<"$artifact_json")
    artifact_head_sha=$(jq -r '.workflow_run.head_sha // empty' <<<"$artifact_json")
    if [[ ! "$artifact_run_id" =~ ^[1-9][0-9]*$ ]] ||
      [[ ! "$artifact_id" =~ ^[1-9][0-9]*$ ]] ||
      [ "$artifact_run_id" = "$CURRENT_RUN_ID" ]; then
      continue
    fi

    local branch_maybe_relevant=false
    if [ "$artifact_branch" = "$DEFAULT_BRANCH" ]; then
      branch_maybe_relevant=true
    elif [ -n "${CURRENT_PR_HEAD_REF:-}" ] && [ "$artifact_branch" = "$CURRENT_PR_HEAD_REF" ]; then
      branch_maybe_relevant=true
    elif [ -n "${CURRENT_PR_NUMBER:-}" ] && [[ "$artifact_branch" =~ (^|/)pr-${CURRENT_PR_NUMBER}- ]]; then
      branch_maybe_relevant=true
    fi
    [ "$branch_maybe_relevant" = "true" ] || continue

    local run_json
    if ! run_json=$(gh api "repos/${REPO}/actions/runs/${artifact_run_id}" 2>/dev/null); then
      continue
    fi
    if ! jq -e \
      --arg repo "$REPO" \
      --arg workflow "$RUNNER_BINARY_WORKFLOW_PATH" \
      --argjson run_id "$artifact_run_id" \
      --arg artifact_head_sha "$artifact_head_sha" '
        .id == $run_id and
        .repository.full_name == $repo and
        .path == $workflow and
        .status == "completed" and
        .conclusion == "success" and
        .head_sha == $artifact_head_sha and
        (.run_attempt | type == "number" and . > 0)
      ' <<<"$run_json" >/dev/null; then
      continue
    fi

    local source="" rank="" run_event run_branch
    run_event=$(jq -r '.event' <<<"$run_json")
    run_branch=$(jq -r '.head_branch' <<<"$run_json")
    if [ "$run_event" = "push" ] && [ "$run_branch" = "$DEFAULT_BRANCH" ]; then
      source="protected-main"
      case "$CURRENT_EVENT" in
        pull_request) rank=0 ;;
        merge_group) rank=1 ;;
        push) rank=0 ;;
      esac
    elif [ -n "${CURRENT_PR_NUMBER:-}" ] && [ "$run_event" = "pull_request" ] &&
      jq -e --argjson pr "$CURRENT_PR_NUMBER" 'any(.pull_requests[]?; .number == $pr)' \
        <<<"$run_json" >/dev/null; then
      source="same-pr"
      case "$CURRENT_EVENT" in
        pull_request) rank=1 ;;
        merge_group) rank=0 ;;
        push) continue ;;
      esac
    elif [ -n "${CURRENT_PR_NUMBER:-}" ] && [ "$run_event" = "merge_group" ] &&
      [[ "$run_branch" =~ (^|/)pr-${CURRENT_PR_NUMBER}- ]]; then
      source="same-pr"
      case "$CURRENT_EVENT" in
        pull_request) rank=1 ;;
        merge_group) rank=0 ;;
        push) continue ;;
      esac
    else
      continue
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$rank" "$artifact_created" "$artifact_id" "$artifact_run_id" "$source" \
      "$(base64 -w0 <<<"$run_json")" >> "$candidates_file"
  done < <(jq -r \
    --arg name "$artifact_name_value" '
      .[] | .artifacts[]? |
      select(.name == $name and .expired == false) |
      @base64
    ' <<<"$artifacts_json")

  local sorted_candidates
  sorted_candidates="${SHADOW_OUTPUT_DIR}/trusted-candidates-sorted.tsv"
  sort -t $'\t' -k1,1n -k2,2r "$candidates_file" > "$sorted_candidates"

  while IFS=$'\t' read -r _rank _created artifact_id artifact_run_id source run_encoded; do
    [ -n "$artifact_run_id" ] || continue
    local candidate_dir manifest_path run_json
    candidate_dir="${SHADOW_OUTPUT_DIR}/candidate-${artifact_id}"
    rm -rf "$candidate_dir"
    mkdir -p "$candidate_dir"
    if ! gh run download "$artifact_run_id" -n "$artifact_name_value" -D "$candidate_dir" \
      >/dev/null 2>&1; then
      continue
    fi
    mapfile -t manifest_candidates < <(find "$candidate_dir" -type f -name manifest.json | sort)
    if [ "${#manifest_candidates[@]}" -ne 1 ]; then
      continue
    fi
    manifest_path="${manifest_candidates[0]}"
    run_json=$(base64 -d <<<"$run_encoded")
    if ! MANIFEST_PATH="$manifest_path" \
      EXPECTED_TARGET="$FRESH_TARGET" \
      EXPECTED_BINARY_INPUT_DIGEST="$FRESH_BINARY_INPUT_DIGEST" \
      EXPECTED_REPOSITORY="$REPO" \
      EXPECTED_WORKFLOW_PATH="$RUNNER_BINARY_WORKFLOW_PATH" \
        "$0" manifest-validate >/dev/null 2>&1; then
      continue
    fi

    local run_attempt run_event run_head_sha manifest_pr expected_pr_json
    run_attempt=$(jq -r '.run_attempt' <<<"$run_json")
    run_event=$(jq -r '.event' <<<"$run_json")
    run_head_sha=$(jq -r '.head_sha' <<<"$run_json")
    manifest_pr=$(jq -r '.producer.prNumber // empty' "$manifest_path")
    if [ "$source" = "same-pr" ]; then
      expected_pr_json="$CURRENT_PR_NUMBER"
    else
      expected_pr_json="null"
    fi
    if ! jq -e \
      --argjson run_id "$artifact_run_id" \
      --argjson run_attempt "$run_attempt" \
      --arg event "$run_event" \
      --arg head_sha "$run_head_sha" \
      --argjson pr_number "$expected_pr_json" '
        .producer.runId == $run_id and
        .producer.runAttempt == $run_attempt and
        .producer.event == $event and
        .producer.headSha == $head_sha and
        .producer.prNumber == $pr_number
      ' "$manifest_path" >/dev/null; then
      continue
    fi
    if [ "$source" = "same-pr" ] && [ "$manifest_pr" != "$CURRENT_PR_NUMBER" ]; then
      continue
    fi

    local candidate_runner_sha candidate_runner_size candidate_guests
    candidate_runner_sha=$(jq -r '.runner.sha256' "$manifest_path")
    candidate_runner_size=$(jq -r '.runner.sizeBytes' "$manifest_path")
    candidate_guests=$(jq -cS '.guests' "$manifest_path")
    if [ "$candidate_runner_sha" != "$FRESH_RUNNER_SHA" ] ||
      [ "$candidate_runner_size" != "$FRESH_RUNNER_SIZE" ] ||
      [ "$candidate_guests" != "$FRESH_GUESTS" ]; then
      shadow_result "conflict" "$source" "equal-input-output-mismatch" "$artifact_run_id"
      echo "equal runner binary input digest produced conflicting output identity: current run ${CURRENT_RUN_ID}, candidate run ${artifact_run_id}" >&2
      return 1
    fi

    shadow_result "hit" "$source" "equal-output" "$artifact_run_id"
    return 0
  done < "$sorted_candidates"

  shadow_result "miss" "" "no-trusted-candidate"
}

usage() {
  cat <<'USAGE'
Usage: runner-binary-cache.sh <fresh-validate|artifact-name|manifest-validate|publish|shadow-resolve>
USAGE
}

case "${1:-}" in
  fresh-validate) fresh_validate ;;
  artifact-name) artifact_name ;;
  manifest-validate) manifest_validate ;;
  publish) publish ;;
  shadow-resolve) shadow_resolve ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
