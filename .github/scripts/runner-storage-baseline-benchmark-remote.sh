#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=${1:?Missing Runner binary directory}
SERVICE=${2:?Missing Runner service name}
GROUP=${3:?Missing Runner group}
RUNNER_DIR=${4:?Missing Runner directory}
SOURCE_REVISION=${5:?Missing vm0-skills source revision}
SAMPLES=${6:?Missing sample count}
REPORT=${7:?Missing report script path}

PROFILE=vm0/default
UNIT="vm0-runner-${SERVICE}.service"
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"
SKILLS_ROOT=/home/user/.claude/skills
SOURCE_URL=https://github.com/vm0-ai/vm0-skills.git
BENCHMARK_DIR=""
SERVER_PID=""
BENCHMARK_SERVICE_STARTED=false
ORIGINAL_SERVICE_RESTARTED=false
RAW_SAMPLES=""
TELEMETRY=""
LAST_RUN_ID=""
LAST_SANDBOX_ID=""
LAST_SUBMIT_ERROR=""
CGROUP_PATH=""

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

if [[ ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  fail "Source revision must be a full lowercase 40-character Git commit"
fi
case "$SAMPLES" in
  ''|*[!0-9]*) fail "Sample count must be an integer" ;;
esac
if [ "$SAMPLES" -lt 1 ] || [ "$SAMPLES" -gt 100 ]; then
  fail "Sample count must be between 1 and 100"
fi
if [ ! -x "$REPORT" ]; then
  fail "Report script is not executable: $REPORT"
fi

wait_for_unit_inactive() {
  local attempt
  for attempt in $(seq 1 60); do
    if ! sudo systemctl is-active --quiet "$UNIT"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

restart_original_service() {
  if [ "$ORIGINAL_SERVICE_RESTARTED" = true ]; then
    return
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SERVICE" --force >/dev/null 2>&1 || true
  wait_for_unit_inactive || true
  sudo "$BIN_DIR/runner" service start --name "$SERVICE" \
    --config "$RUNNER_DIR/runner.yaml" \
    --local \
    --env USE_MOCK_CLAUDE=true >/dev/null
  sudo "$BIN_DIR/runner" service wait-running --name "$SERVICE" --timeout-secs 120 >/dev/null
  ORIGINAL_SERVICE_RESTARTED=true
}

cleanup() {
  local status=$?
  if [ "$BENCHMARK_SERVICE_STARTED" = true ]; then
    sudo "$BIN_DIR/runner" service stop --name "$SERVICE" --force >/dev/null 2>&1 || true
    wait_for_unit_inactive || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$BENCHMARK_DIR" ] && [[ "$BENCHMARK_DIR" == /tmp/vm0-storage-baseline.* ]]; then
    rm -rf "$BENCHMARK_DIR"
  fi
  restart_original_service || true
  return "$status"
}
trap cleanup EXIT

BENCHMARK_DIR=$(mktemp -d /tmp/vm0-storage-baseline.XXXXXX)
SOURCE_DIR="$BENCHMARK_DIR/source"
ARCHIVE_DIR="$BENCHMARK_DIR/archives"
MANIFEST="$BENCHMARK_DIR/storage-manifest.json"
MOUNTS="$BENCHMARK_DIR/mounts.jsonl"
CHECKSUMS="$BENCHMARK_DIR/checksums"
TELEMETRY="$BENCHMARK_DIR/telemetry.jsonl"
RAW_SAMPLES="$BENCHMARK_DIR/samples.jsonl"
PORT_FILE="$BENCHMARK_DIR/server.port"
SERVER_LOG="$BENCHMARK_DIR/server.log"
mkdir -p "$ARCHIVE_DIR"
: > "$TELEMETRY"
: > "$RAW_SAMPLES"

echo "=== Reproducing default-seed fixture ==="
git init -q "$SOURCE_DIR"
git -C "$SOURCE_DIR" remote add origin "$SOURCE_URL"
git -C "$SOURCE_DIR" fetch -q --depth=1 origin "$SOURCE_REVISION"
RESOLVED_REVISION=$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)
[ "$RESOLVED_REVISION" = "$SOURCE_REVISION" ] \
  || fail "Fetched source revision does not match the requested commit"
git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD

for skill in computer-use gen workflow-setup; do
  [ -d "$SOURCE_DIR/$skill" ] || fail "Source revision is missing seed skill: $skill"
  unexpected_entry=$(find "$SOURCE_DIR/$skill" ! -type d ! -type f -print -quit)
  [ -z "$unexpected_entry" ] \
    || fail "Source seed skill contains a non-regular entry: $unexpected_entry"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -C "$SOURCE_DIR/$skill" -cf - . \
    | gzip -n > "$ARCHIVE_DIR/$skill.tar.gz"
  while IFS= read -r -d '' source_file; do
    relative_path=${source_file#"$SOURCE_DIR/$skill/"}
    checksum=$(sha256sum "$source_file" | awk '{print $1}')
    printf '%s  %s/%s/%s\n' "$checksum" "$SKILLS_ROOT" "$skill" "$relative_path" \
      >> "$CHECKSUMS"
  done < <(find "$SOURCE_DIR/$skill" -type f -print0 | sort -z)
done
EXPECTED_FILE_COUNT=$(wc -l < "$CHECKSUMS")
TREE_DIGEST=$(sha256sum "$CHECKSUMS" | awk '{print $1}')
RUNNER_DIGEST=$(sudo sha256sum "$BIN_DIR/runner" | awk '{print $1}')
CONFIG_DIGEST=$(sudo sha256sum "$RUNNER_DIR/runner.yaml" | awk '{print $1}')
ROOTFS_HASH=$(sudo awk '$1 == "rootfs_hash:" {print $2; exit}' "$RUNNER_DIR/runner.yaml")
SNAPSHOT_HASH=$(sudo awk '$1 == "snapshot_hash:" {print $2; exit}' "$RUNNER_DIR/runner.yaml")
[ -n "$ROOTFS_HASH" ] || fail "Runner config omitted rootfs_hash"
[ -n "$SNAPSHOT_HASH" ] || fail "Runner config omitted snapshot_hash"
DESCRIPTOR_DIGEST=$(printf '%s\n' \
  "$SOURCE_REVISION" \
  "$TREE_DIGEST" \
  claude-code \
  "$PROFILE" \
  "$RUNNER_DIGEST" \
  "$ROOTFS_HASH" \
  "$SNAPSHOT_HASH" \
  | sha256sum | awk '{print $1}')

python3 - "$ARCHIVE_DIR" "$TELEMETRY" "$PORT_FILE" >"$SERVER_LOG" 2>&1 <<'PY' &
import http.server
import json
import pathlib
import sys
import threading

archive_dir = pathlib.Path(sys.argv[1]).resolve()
telemetry_path = pathlib.Path(sys.argv[2])
port_path = pathlib.Path(sys.argv[3])
write_lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format_string, *args):
        return

    def do_GET(self):
        prefix = "/archives/"
        if not self.path.startswith(prefix):
            self.send_error(404)
            return
        name = self.path[len(prefix):]
        if not name or "/" in name or name in {".", ".."}:
            self.send_error(404)
            return
        path = archive_dir / name
        if not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/webhooks/agent/telemetry":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 8 * 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400)
            return
        encoded = json.dumps(payload, separators=(",", ":"))
        with write_lock:
            with telemetry_path.open("a", encoding="utf-8") as output:
                output.write(encoded + "\n")
        response = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_path.write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
PY
SERVER_PID=$!

for _ in $(seq 1 100); do
  [ -s "$PORT_FILE" ] && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat "$SERVER_LOG" >&2
    fail "Fixture server exited before publishing its port"
  fi
  sleep 0.05
done
[ -s "$PORT_FILE" ] || fail "Fixture server did not publish its port"
FIXTURE_PORT=$(<"$PORT_FILE")
FIXTURE_URL="http://127.0.0.1:${FIXTURE_PORT}"

for skill in computer-use gen workflow-setup; do
  archive="$ARCHIVE_DIR/$skill.tar.gz"
  size=$(stat -c %s "$archive")
  jq -cn \
    --arg name "$skill" \
    --arg storage_id "default-seed-fixture-$skill" \
    --arg version_id "$SOURCE_REVISION" \
    --arg mount_path "$SKILLS_ROOT/$skill" \
    --arg archive_url "$FIXTURE_URL/archives/$skill.tar.gz" \
    --argjson archive_size "$size" \
    '{
      name: $name,
      storageId: $storage_id,
      versionId: $version_id,
      mountPath: $mount_path,
      archiveUrl: $archive_url,
      archiveSize: $archive_size,
      baselineCandidate: true
    }' >> "$MOUNTS"
done
jq -s '{storageMounts: .}' "$MOUNTS" > "$MANIFEST"
chmod 0600 "$MANIFEST"

disk_bytes() {
  local mode=$1
  shift
  local option=()
  if [ "$mode" = logical ]; then
    option=(--apparent-size)
  fi
  sudo du "${option[@]}" -s -B1 "$@" 2>/dev/null | awk '{sum += $1} END {print sum + 0}'
}

FIXTURE_LOGICAL_BYTES=$(disk_bytes logical "$BENCHMARK_DIR")
FIXTURE_ALLOCATED_BYTES=$(disk_bytes allocated "$BENCHMARK_DIR")

echo "=== Starting isolated local Runner telemetry boundary ==="
sudo "$BIN_DIR/runner" service stop --name "$SERVICE" --force >/dev/null 2>&1 || true
wait_for_unit_inactive || fail "Runner service did not stop before benchmark"
sudo "$BIN_DIR/runner" service start --name "$SERVICE" \
  --config "$RUNNER_DIR/runner.yaml" \
  --local \
  --env USE_MOCK_CLAUDE=true \
  --env "OKOU_API_BACKEND_URL=$FIXTURE_URL"
BENCHMARK_SERVICE_STARTED=true
sudo "$BIN_DIR/runner" service wait-running --name "$SERVICE" --timeout-secs 120 >/dev/null
CGROUP_PATH=$(sudo systemctl show "$UNIT" --property=ControlGroup --value)
[ -n "$CGROUP_PATH" ] || fail "Runner service cgroup is unavailable"

cpu_usage_usec() {
  sudo awk '$1 == "usage_usec" {print $2}' "/sys/fs/cgroup${CGROUP_PATH}/cpu.stat"
}

wait_for_telemetry() {
  local run_id=$1
  local attempt
  for attempt in $(seq 1 200); do
    if jq -s -e --arg run_id "$run_id" \
      'any(.[]; .runId == $run_id and (.sandboxOperations | length) > 0)' \
      "$TELEMETRY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

operations_for_run() {
  local run_id=$1
  "$REPORT" --operations "$TELEMETRY" "$run_id"
}

operation_duration() {
  local operations=$1
  local action=$2
  jq -r --arg action "$action" \
    '[.[] | select(.action_type == $action)] | last | .duration_ms // empty' \
    <<<"$operations"
}

operation_reuse_result() {
  local operations=$1
  jq -r \
    '[.[] | select(.action_type == "api_to_spawn")] | last | .sandbox_reuse_result // empty' \
    <<<"$operations"
}

sandbox_for_thread() {
  local chat_thread_id=$1
  local reuse_key="thread:$chat_thread_id"
  local sandbox_id
  local attempt

  for attempt in $(seq 1 100); do
    sandbox_id=$(sudo jq -r --arg reuse_key "$reuse_key" \
      '.idle_sandboxes[]? | select(.reuse_key == $reuse_key) | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null || true)
    if [ -n "$sandbox_id" ]; then
      printf '%s\n' "$sandbox_id"
      return 0
    fi
    sleep 0.05
  done
  return 1
}

record_completed_sample() {
  local cohort=$1
  local chat_thread_id=$2
  local expected_reuse=$3
  local candidate_gate_overhead_ms=$4
  local cpu_usec=$5
  local submit_status=$6
  local submit_output=$7
  local submit_json
  local operations
  local reuse_result
  local api_to_spawn_ms
  local storage_apply_ms
  local storage_cache_populate_ms
  local storage_guest_download_ms
  local sandbox_create_ms
  local agent_spawn_ms

  LAST_RUN_ID=""
  LAST_SANDBOX_ID=""
  LAST_SUBMIT_ERROR=""
  if [ "$submit_status" -ne 0 ]; then
    LAST_SUBMIT_ERROR=submit_failed
    jq -cn --arg cohort "$cohort" --arg error_code "$LAST_SUBMIT_ERROR" \
      '{kind:"sample",cohort:$cohort,success:false,error_code:$error_code}' >> "$RAW_SAMPLES"
    return 1
  fi
  submit_json=$(awk '/^\{/{line=$0} END{print line}' <<<"$submit_output")
  LAST_RUN_ID=$(jq -r '.run_id // empty' <<<"$submit_json" 2>/dev/null || true)
  if [ -z "$LAST_RUN_ID" ]; then
    LAST_SUBMIT_ERROR=missing_run_id
    jq -cn --arg cohort "$cohort" --arg error_code "$LAST_SUBMIT_ERROR" \
      '{kind:"sample",cohort:$cohort,success:false,error_code:$error_code}' >> "$RAW_SAMPLES"
    return 1
  fi
  if ! wait_for_telemetry "$LAST_RUN_ID"; then
    LAST_SUBMIT_ERROR=telemetry_missing
    jq -cn --arg cohort "$cohort" --arg run_id "$LAST_RUN_ID" --arg error_code "$LAST_SUBMIT_ERROR" \
      '{kind:"sample",cohort:$cohort,success:false,run_id:$run_id,error_code:$error_code}' \
      >> "$RAW_SAMPLES"
    return 1
  fi
  operations=$(operations_for_run "$LAST_RUN_ID")
  reuse_result=$(operation_reuse_result "$operations")
  if [ "$reuse_result" != "$expected_reuse" ]; then
    LAST_SUBMIT_ERROR=unexpected_reuse_result
    jq -cn \
      --arg cohort "$cohort" \
      --arg run_id "$LAST_RUN_ID" \
      --arg error_code "$LAST_SUBMIT_ERROR" \
      --arg expected_reuse "$expected_reuse" \
      --arg actual_reuse "$reuse_result" \
      '{kind:"sample",cohort:$cohort,success:false,run_id:$run_id,error_code:$error_code,expected_reuse:$expected_reuse,actual_reuse:$actual_reuse}' \
      >> "$RAW_SAMPLES"
    return 1
  fi

  api_to_spawn_ms=$(operation_duration "$operations" api_to_spawn)
  storage_apply_ms=$(operation_duration "$operations" runner_storage_manifest_apply)
  storage_cache_populate_ms=$(operation_duration "$operations" runner_storage_manifest_cache_populate)
  storage_guest_download_ms=$(operation_duration "$operations" runner_storage_manifest_guest_download)
  sandbox_create_ms=$(operation_duration "$operations" sandbox_create)
  agent_spawn_ms=$(operation_duration "$operations" runner_agent_start_process)
  [ -n "$api_to_spawn_ms" ] || fail "api_to_spawn telemetry missing for $LAST_RUN_ID"
  [ -n "$storage_apply_ms" ] || fail "storage apply telemetry missing for $LAST_RUN_ID"
  [ -n "$agent_spawn_ms" ] || fail "real agent spawn telemetry missing for $LAST_RUN_ID"
  if [ "$cohort" = fresh ] || [ "$cohort" = validation ]; then
    [ -n "$storage_guest_download_ms" ] \
      || fail "fresh sample omitted guest storage application for $LAST_RUN_ID"
    [ -n "$sandbox_create_ms" ] \
      || fail "fresh sample omitted sandbox creation for $LAST_RUN_ID"
  fi
  if [ "$cohort" = prepared ] && [ -n "$storage_guest_download_ms" ]; then
    fail "prepared sample unexpectedly downloaded storage for $LAST_RUN_ID"
  fi
  if ! LAST_SANDBOX_ID=$(sandbox_for_thread "$chat_thread_id"); then
    fail "reusable sandbox was not published for $LAST_RUN_ID"
  fi

  jq -cn \
    --arg cohort "$cohort" \
    --arg run_id "$LAST_RUN_ID" \
    --arg sandbox_id "$LAST_SANDBOX_ID" \
    --argjson api_to_spawn_ms "$api_to_spawn_ms" \
    --argjson storage_apply_ms "$storage_apply_ms" \
    --argjson storage_cache_populate_ms "${storage_cache_populate_ms:-null}" \
    --argjson storage_guest_download_ms "${storage_guest_download_ms:-null}" \
    --argjson sandbox_create_ms "${sandbox_create_ms:-null}" \
    --argjson agent_spawn_ms "$agent_spawn_ms" \
    --argjson cpu_usec "$cpu_usec" \
    --argjson candidate_gate_overhead_ms "${candidate_gate_overhead_ms:-null}" \
    '{
      kind:"sample",
      cohort:$cohort,
      success:true,
      run_id:$run_id,
      sandbox_id:$sandbox_id,
      api_to_spawn_ms:$api_to_spawn_ms,
      storage_apply_ms:$storage_apply_ms,
      storage_cache_populate_ms:$storage_cache_populate_ms,
      storage_guest_download_ms:$storage_guest_download_ms,
      sandbox_create_ms:$sandbox_create_ms,
      agent_spawn_ms:$agent_spawn_ms,
      cpu_usec:$cpu_usec,
      candidate_gate_overhead_ms:$candidate_gate_overhead_ms,
      candidate_ready_proxy_ms: (
        $api_to_spawn_ms + (if $candidate_gate_overhead_ms == null then 0 else $candidate_gate_overhead_ms end)
      )
    }' >> "$RAW_SAMPLES"
}

record_sample() {
  local cohort=$1
  local manifest=$2
  local chat_thread_id=$3
  local session_id=$4
  local expected_reuse=$5
  local candidate_gate_overhead_ms=${6:-}
  local prompt=${7:-true}
  local cpu_before
  local cpu_after
  local submit_output
  local submit_status=0

  cpu_before=$(cpu_usage_usec)
  if submit_output=$(sudo "$BIN_DIR/runner" local submit \
    --group "$GROUP" \
    --profile "$PROFILE" \
    --chat-thread-id "$chat_thread_id" \
    --session-id "$session_id" \
    --feature-flag sandboxReuse=true \
    --storage-manifest "$manifest" \
    --timeout 120 \
    --prompt "$prompt" 2>&1); then
    submit_status=0
  else
    submit_status=$?
  fi
  cpu_after=$(cpu_usage_usec)
  record_completed_sample "$cohort" "$chat_thread_id" "$expected_reuse" \
    "$candidate_gate_overhead_ms" "$((cpu_after - cpu_before))" "$submit_status" "$submit_output"
}

CHECKSUMS_BASE64=$(base64 -w0 "$CHECKSUMS")
ATTEST_PROMPT='test "$(cat /tmp/vm0-default-seed-baseline-descriptor 2>/dev/null)" = "$EXPECTED_DESCRIPTOR" || exit 91; test -z "$(find /home/user/.claude/skills/computer-use /home/user/.claude/skills/gen /home/user/.claude/skills/workflow-setup ! -type d ! -type f -print -quit)" || exit 92; actual_count=$(find /home/user/.claude/skills/computer-use /home/user/.claude/skills/gen /home/user/.claude/skills/workflow-setup -type f -print | wc -l); [ "$actual_count" -eq "$EXPECTED_FILE_COUNT" ] || exit 93; printf %s "$EXPECTED_CHECKSUMS" | base64 -d | sha256sum -c - >/dev/null || exit 94'

run_candidate_gate() {
  local candidate_sandbox_id=$1
  local chat_thread_id=$2
  local session_id=$3
  local cpu_before
  local cpu_after
  local started_ns
  local finished_ns
  local submit_json
  local job_exit_code
  local operations
  local reuse_result
  local api_to_spawn_ms
  local published_sandbox_id

  GATE_ATTESTED=false
  GATE_OVERHEAD_MS=""
  GATE_OUTPUT=""
  GATE_STATUS=0
  GATE_ERROR=""
  GATE_ELAPSED_MS=""
  cpu_before=$(cpu_usage_usec)
  started_ns=$(date +%s%N)
  if GATE_OUTPUT=$(sudo "$BIN_DIR/runner" local submit \
    --group "$GROUP" \
    --profile "$PROFILE" \
    --chat-thread-id "$chat_thread_id" \
    --session-id "$session_id" \
    --feature-flag sandboxReuse=true \
    --storage-manifest "$MANIFEST" \
    --env "EXPECTED_DESCRIPTOR=$DESCRIPTOR_DIGEST" \
    --env "EXPECTED_CHECKSUMS=$CHECKSUMS_BASE64" \
    --env "EXPECTED_FILE_COUNT=$EXPECTED_FILE_COUNT" \
    --timeout 120 \
    --prompt "$ATTEST_PROMPT" 2>&1); then
    GATE_STATUS=0
  else
    GATE_STATUS=$?
  fi
  cpu_after=$(cpu_usage_usec)
  finished_ns=$(date +%s%N)
  GATE_CPU_USEC=$((cpu_after - cpu_before))
  GATE_ELAPSED_MS=$(((finished_ns - started_ns) / 1000000))

  submit_json=$(awk '/^\{/{line=$0} END{print line}' <<<"$GATE_OUTPUT")
  GATE_RUN_ID=$(jq -r '.run_id // empty' <<<"$submit_json" 2>/dev/null || true)
  job_exit_code=$(jq -r '.exit_code // empty' <<<"$submit_json" 2>/dev/null || true)
  if [ -z "$GATE_RUN_ID" ] || [ -z "$job_exit_code" ]; then
    GATE_ERROR=candidate_result_unavailable
    return 2
  fi
  if ! wait_for_telemetry "$GATE_RUN_ID"; then
    GATE_ERROR=candidate_telemetry_unavailable
    return 2
  fi
  operations=$(operations_for_run "$GATE_RUN_ID")
  reuse_result=$(operation_reuse_result "$operations")
  if [ "$reuse_result" != reused ]; then
    GATE_ERROR=candidate_not_reused
    return 2
  fi
  api_to_spawn_ms=$(operation_duration "$operations" api_to_spawn)
  if [ -z "$api_to_spawn_ms" ]; then
    GATE_ERROR=candidate_agent_spawn_unavailable
    return 2
  fi
  case "$job_exit_code" in
    91) GATE_ERROR=candidate_descriptor_rejected; return 1 ;;
    92) GATE_ERROR=candidate_entry_type_rejected; return 1 ;;
    93) GATE_ERROR=candidate_file_set_rejected; return 1 ;;
    94) GATE_ERROR=candidate_checksum_rejected; return 1 ;;
  esac
  if [ "$GATE_STATUS" -ne 0 ] || [ "$job_exit_code" -ne 0 ]; then
    GATE_ERROR=candidate_execution_failed
    return 2
  fi
  if [ "$GATE_ELAPSED_MS" -gt "$api_to_spawn_ms" ]; then
    GATE_OVERHEAD_MS=$((GATE_ELAPSED_MS - api_to_spawn_ms))
  else
    GATE_OVERHEAD_MS=0
  fi
  if ! published_sandbox_id=$(sandbox_for_thread "$chat_thread_id"); then
    GATE_ERROR=candidate_not_republished
    return 2
  fi
  if [ "$published_sandbox_id" != "$candidate_sandbox_id" ]; then
    GATE_ERROR=candidate_identity_changed
    return 2
  fi
  GATE_ATTESTED=true
}

assert_candidate_rejected_then_fresh() {
  local name=$1
  local mutation=$2
  local candidate_sandbox_id=$3
  local candidate_thread=$4
  local fallback_manifest=${5:-$MANIFEST}
  local fallback_thread
  local gate_status

  record_sample warmup "$MANIFEST" "$candidate_thread" \
    "storage-baseline-mutate-$name" reused "" "$mutation" \
    || fail "Could not create invalid prepared candidate: $name"
  [ "$LAST_SANDBOX_ID" = "$candidate_sandbox_id" ] \
    || fail "Invalidation changed prepared sandbox identity: $name"
  if run_candidate_gate "$candidate_sandbox_id" "$candidate_thread" \
    "storage-baseline-reject-$name"; then
    gate_status=0
  else
    gate_status=$?
  fi
  [ "$gate_status" -ne 0 ] || fail "Invalid prepared candidate was accepted: $name"
  [ "$gate_status" -eq 1 ] \
    || fail "Invalid prepared candidate could not be checked: $name"
  fallback_thread=$(cat /proc/sys/kernel/random/uuid)
  record_sample validation "$fallback_manifest" "$fallback_thread" \
    "storage-baseline-validation-$name" poolMiss "" true \
    || fail "Fresh fallback failed for invalid candidate: $name"
  jq -cn --arg case "$name" --arg run_id "$LAST_RUN_ID" \
    '{kind:"validation",case:$case,prepared_candidate_rejected:true,fresh_complete_path:true,run_id:$run_id}' \
    >> "$RAW_SAMPLES"
}

jq -cn \
  --arg source_revision "$SOURCE_REVISION" \
  --arg tree_digest "$TREE_DIGEST" \
  --arg descriptor_digest "$DESCRIPTOR_DIGEST" \
  --arg runner_digest "$RUNNER_DIGEST" \
  --arg config_digest "$CONFIG_DIGEST" \
  --arg rootfs_hash "$ROOTFS_HASH" \
  --arg snapshot_hash "$SNAPSHOT_HASH" \
  --arg profile "$PROFILE" \
  --argjson samples "$SAMPLES" \
  --argjson fixture_logical_bytes "$FIXTURE_LOGICAL_BYTES" \
  --argjson fixture_allocated_bytes "$FIXTURE_ALLOCATED_BYTES" \
  '{
    kind:"metadata",
    source_revision:$source_revision,
    tree_digest:$tree_digest,
    descriptor_digest:$descriptor_digest,
    runner_digest:$runner_digest,
    config_digest:$config_digest,
    rootfs_hash:$rootfs_hash,
    snapshot_hash:$snapshot_hash,
    profile:$profile,
    samples_per_cohort:$samples,
    fixture_logical_bytes:$fixture_logical_bytes,
    fixture_allocated_bytes:$fixture_allocated_bytes
  }' >> "$RAW_SAMPLES"

echo "=== Warming exact source archives ==="
CACHE_WARM_THREAD=$(cat /proc/sys/kernel/random/uuid)
record_sample warmup "$MANIFEST" "$CACHE_WARM_THREAD" storage-baseline-cache-warm poolMiss "" true \
  || fail "Archive-cache warmup failed: $LAST_SUBMIT_ERROR"

echo "=== Sampling current fresh staging path ==="
for index in $(seq 1 "$SAMPLES"); do
  thread_id=$(cat /proc/sys/kernel/random/uuid)
  record_sample fresh "$MANIFEST" "$thread_id" "storage-baseline-fresh-$index" poolMiss "" true \
    || fail "Fresh sample $index failed: $LAST_SUBMIT_ERROR"
done

echo "=== Preparing exact reusable sandbox ==="
PREPARED_THREAD=$(cat /proc/sys/kernel/random/uuid)
PREPARE_PROMPT="printf '%s\\n' '$DESCRIPTOR_DIGEST' > /tmp/vm0-default-seed-baseline-descriptor"
record_sample warmup "$MANIFEST" "$PREPARED_THREAD" storage-baseline-prepared poolMiss "" "$PREPARE_PROMPT" \
  || fail "Prepared baseline construction failed: $LAST_SUBMIT_ERROR"
PREPARED_SANDBOX_ID=$LAST_SANDBOX_ID

echo "=== Sampling exact prepared path ==="
for index in $(seq 1 "$SAMPLES"); do
  if run_candidate_gate "$PREPARED_SANDBOX_ID" "$PREPARED_THREAD" \
    "storage-baseline-prepared-$index"; then
    gate_status=0
  else
    gate_status=$?
  fi
  if [ "$gate_status" -eq 2 ]; then
    jq -cn \
      --arg run_id "$GATE_RUN_ID" \
      --arg error_code "$GATE_ERROR" \
      --argjson cpu_usec "$GATE_CPU_USEC" \
      --argjson candidate_gate_elapsed_ms "$GATE_ELAPSED_MS" \
      '{kind:"sample",cohort:"prepared",success:false,run_id:$run_id,error_code:$error_code,cpu_usec:$cpu_usec,candidate_gate_elapsed_ms:$candidate_gate_elapsed_ms}' \
      >> "$RAW_SAMPLES"
    break
  fi
  [ "$gate_status" -eq 0 ] \
    || fail "Prepared candidate attestation failed before sample $index: $GATE_ERROR"
  record_completed_sample prepared "$PREPARED_THREAD" reused \
    "$GATE_OVERHEAD_MS" "$GATE_CPU_USEC" "$GATE_STATUS" "$GATE_OUTPUT" \
    || fail "Prepared sample $index failed: $LAST_SUBMIT_ERROR"
  PREPARED_SANDBOX_ID=$LAST_SANDBOX_ID
done

prepare_validation_candidate() {
  local name=$1
  VALIDATION_THREAD=$(cat /proc/sys/kernel/random/uuid)
  record_sample warmup "$MANIFEST" "$VALIDATION_THREAD" \
    "storage-baseline-candidate-$name" poolMiss "" "$PREPARE_PROMPT" \
    || fail "Could not prepare validation candidate: $name"
  VALIDATION_SANDBOX_ID=$LAST_SANDBOX_ID
}

echo "=== Verifying prepared candidate invalidation ==="
prepare_validation_candidate missing-marker
assert_candidate_rejected_then_fresh missing-marker \
  'rm -f /tmp/vm0-default-seed-baseline-descriptor' \
  "$VALIDATION_SANDBOX_ID" "$VALIDATION_THREAD"
prepare_validation_candidate stale-descriptor
assert_candidate_rejected_then_fresh stale-descriptor \
  'printf "%s\n" stale > /tmp/vm0-default-seed-baseline-descriptor' \
  "$VALIDATION_SANDBOX_ID" "$VALIDATION_THREAD"
prepare_validation_candidate incomplete-tree
assert_candidate_rejected_then_fresh incomplete-tree \
  "find '$SKILLS_ROOT/computer-use' -type f -print -quit | xargs -r rm -f" \
  "$VALIDATION_SANDBOX_ID" "$VALIDATION_THREAD"
prepare_validation_candidate corrupt-tree
assert_candidate_rejected_then_fresh corrupt-tree \
  "find '$SKILLS_ROOT/gen' -type f -print -quit | xargs -r sh -c 'printf corrupt >> \"\$1\"' sh" \
  "$VALIDATION_SANDBOX_ID" "$VALIDATION_THREAD"
prepare_validation_candidate unexpected-file
assert_candidate_rejected_then_fresh unexpected-file \
  "touch '$SKILLS_ROOT/workflow-setup/.vm0-unexpected'" \
  "$VALIDATION_SANDBOX_ID" "$VALIDATION_THREAD"

CHANGED_MANIFEST="$BENCHMARK_DIR/storage-manifest-changed.json"
jq --arg version_id "${SOURCE_REVISION}-changed" \
  '.storageMounts[0].versionId = $version_id' "$MANIFEST" > "$CHANGED_MANIFEST"
chmod 0600 "$CHANGED_MANIFEST"
prepare_validation_candidate mismatched-descriptor
assert_candidate_rejected_then_fresh mismatched-descriptor \
  'printf "%s\n" mismatched-environment > /tmp/vm0-default-seed-baseline-descriptor' \
  "$VALIDATION_SANDBOX_ID" "$VALIDATION_THREAD" "$CHANGED_MANIFEST"

expect_current_archive_failure() {
  local name=$1
  local manifest=$2
  local thread_id
  local output
  local status=0
  local run_id
  local operations
  thread_id=$(cat /proc/sys/kernel/random/uuid)
  if output=$(sudo "$BIN_DIR/runner" local submit \
    --group "$GROUP" \
    --profile "$PROFILE" \
    --chat-thread-id "$thread_id" \
    --session-id "storage-baseline-current-$name" \
    --feature-flag sandboxReuse=true \
    --storage-manifest "$manifest" \
    --timeout 120 \
    --prompt true 2>&1); then
    status=0
  else
    status=$?
  fi
  [ "$status" -ne 0 ] || fail "Invalid current archive unexpectedly succeeded: $name"
  run_id=$(awk '/^\{/{line=$0} END{print line}' <<<"$output" | jq -r '.run_id // empty' 2>/dev/null || true)
  [ -n "$run_id" ] || fail "Invalid current archive result omitted run ID: $name"
  wait_for_telemetry "$run_id" || fail "Invalid current archive telemetry missing: $name"
  operations=$(operations_for_run "$run_id")
  jq -e 'any(.[]; .action_type == "runner_storage_manifest_apply" and .success == false)' \
    <<<"$operations" >/dev/null \
    || fail "Invalid current archive did not fail storage application: $name"
  jq -cn --arg case "$name" --arg run_id "$run_id" \
    '{kind:"validation",case:$case,current_complete_path_failed_closed:true,run_id:$run_id}' \
    >> "$RAW_SAMPLES"
}

echo "=== Verifying invalid current archives fail closed ==="
MISSING_MANIFEST="$BENCHMARK_DIR/storage-manifest-missing.json"
jq --arg url "$FIXTURE_URL/archives/missing.tar.gz" --arg version missing-current \
  '.storageMounts[0].archiveUrl = $url | .storageMounts[0].versionId = $version | .storageMounts[0].archiveSize = 1' \
  "$MANIFEST" > "$MISSING_MANIFEST"
chmod 0600 "$MISSING_MANIFEST"
expect_current_archive_failure missing-current-archive "$MISSING_MANIFEST"

printf 'not a gzip archive\n' > "$ARCHIVE_DIR/corrupt.tar.gz"
CORRUPT_SIZE=$(stat -c %s "$ARCHIVE_DIR/corrupt.tar.gz")
CORRUPT_MANIFEST="$BENCHMARK_DIR/storage-manifest-corrupt.json"
jq --arg url "$FIXTURE_URL/archives/corrupt.tar.gz" --arg version corrupt-current \
  --argjson size "$CORRUPT_SIZE" \
  '.storageMounts[0].archiveUrl = $url | .storageMounts[0].versionId = $version | .storageMounts[0].archiveSize = $size' \
  "$MANIFEST" > "$CORRUPT_MANIFEST"
chmod 0600 "$CORRUPT_MANIFEST"
expect_current_archive_failure corrupt-current-archive "$CORRUPT_MANIFEST"

echo "=== Verifying cancellation and queue cleanup ==="
CANCEL_THREAD=$(cat /proc/sys/kernel/random/uuid)
if timeout --signal=INT --kill-after=15s 1s \
  sudo "$BIN_DIR/runner" local submit \
    --group "$GROUP" \
    --profile "$PROFILE" \
    --chat-thread-id "$CANCEL_THREAD" \
    --session-id storage-baseline-cancel \
    --feature-flag sandboxReuse=true \
    --storage-manifest "$MANIFEST" \
    --timeout 120 \
    --prompt 'sleep 30' >"$BENCHMARK_DIR/cancel.out" 2>&1; then
  CANCEL_STATUS=0
else
  CANCEL_STATUS=$?
fi
[ "$CANCEL_STATUS" -ne 0 ] || fail "Cancellation probe unexpectedly completed normally"
for _ in $(seq 1 100); do
  if ! sudo find "$GROUP_DIR" -type f \( -name '*.job' -o -name '*.claim' -o -name '*.cancel' \) \
    -print -quit 2>/dev/null | grep -q .; then
    break
  fi
  sleep 0.1
done
if sudo find "$GROUP_DIR" -type f \( -name '*.job' -o -name '*.claim' -o -name '*.cancel' \) \
  -print -quit 2>/dev/null | grep -q .; then
  fail "Cancellation left local queue ownership files"
fi
jq -cn --argjson exit_status "$CANCEL_STATUS" \
  '{kind:"validation",case:"cancellation",terminal:true,queue_clean:true,exit_status:$exit_status}' \
  >> "$RAW_SAMPLES"

MEMORY_CURRENT_BYTES=$(sudo cat "/sys/fs/cgroup${CGROUP_PATH}/memory.current")
MEMORY_PEAK_BYTES=$(sudo cat "/sys/fs/cgroup${CGROUP_PATH}/memory.peak")
RUNNER_LOGICAL_BYTES=$(disk_bytes logical "$RUNNER_DIR" "$GROUP_DIR")
RUNNER_ALLOCATED_BYTES=$(disk_bytes allocated "$RUNNER_DIR" "$GROUP_DIR")
jq -cn \
  --argjson memory_current_bytes "$MEMORY_CURRENT_BYTES" \
  --argjson memory_peak_bytes "$MEMORY_PEAK_BYTES" \
  --argjson runner_logical_bytes "$RUNNER_LOGICAL_BYTES" \
  --argjson runner_allocated_bytes "$RUNNER_ALLOCATED_BYTES" \
  '{
    kind:"resources",
    memory_current_bytes:$memory_current_bytes,
    memory_peak_bytes:$memory_peak_bytes,
    runner_logical_bytes:$runner_logical_bytes,
    runner_allocated_bytes:$runner_allocated_bytes
  }' >> "$RAW_SAMPLES"

echo "=== Stopping benchmark service and verifying cleanup ==="
sudo "$BIN_DIR/runner" service stop --name "$SERVICE" --force >/dev/null
wait_for_unit_inactive || fail "Runner service did not stop after benchmark"
BENCHMARK_SERVICE_STARTED=false
if sudo find "$GROUP_DIR" -type f \( -name '*.job' -o -name '*.claim' -o -name '*.cancel' \) \
  -print -quit 2>/dev/null | grep -q .; then
  fail "Benchmark cleanup left local queue ownership files"
fi
RAW_OUTPUT=$(cat "$RAW_SAMPLES")
SUMMARY_OUTPUT=$("$REPORT" "$RAW_SAMPLES")

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" >/dev/null 2>&1 || true
SERVER_PID=""
rm -rf "$BENCHMARK_DIR"
BENCHMARK_DIR=""
restart_original_service

echo "=== Storage baseline raw samples ==="
printf '%s\n' "$RAW_OUTPUT"
jq -cn \
  '{kind:"cleanup",service_stopped:true,queue_clean:true,fixture_removed:true,fixture_server_stopped:true,original_service_restarted:true}'
echo "=== Storage baseline summary ==="
printf '%s\n' "$SUMMARY_OUTPUT"
trap - EXIT
