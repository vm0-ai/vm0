#!/usr/bin/env bash
set -euo pipefail

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "::error::OPENAI_API_KEY is required for real Codex active-input smoke"
  exit 1
fi

REMOTE="${METAL_USER}@${HOST}"
{
  # Keep the CI provider key off SSH/bash argv; the runner CLI still
  # receives it through --secret-env because that is the behavior
  # under test.
  printf 'OPENAI_API_KEY=%q\n' "$OPENAI_API_KEY"
  cat <<'REMOTE_SCRIPT'
set -euo pipefail

BIN_DIR=$1
JOB_REF=$2
ROOTFS_HASH=$3
SNAPSHOT_HASH=$4
OFFICIAL_RUNNER_SECRET=$5

SVC="${JOB_REF}-local-codex-active-input"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP="vm0/local-codex-active-input-${JOB_REF}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/local-codex-active-input-${JOB_REF}"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

print_service_logs() {
  echo "--- ${SVC} service logs ---"
  sudo "$BIN_DIR/runner" service logs --name "$SVC" --lines 200 || true
}

cleanup() {
  echo "--- Cleanup local Codex active-input smoke runner ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"

echo "--- Generating local runner config ---"
sudo "$BIN_DIR/runner" config \
  --profile vm0/default \
  --rootfs-hash "$ROOTFS_HASH" \
  --snapshot-hash "$SNAPSHOT_HASH" \
  --name "$SVC" \
  --group "$GROUP" \
  --runner-dirname "$SVC" \
  --max-concurrent 1 \
  --api-url https://not-a-real-server.test \
  --token "vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "--- Starting local runner ---"
sudo "$BIN_DIR/runner" service start \
  --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" \
  --local

PROMPT='This is a CI smoke test for Codex active input. The initial prompt token is codex-initial-8m6. Before your final answer, run shell command `sleep 1` so two follow-up user messages can arrive, each containing one token. After the command and after reading both follow-up messages, reply with exactly RESULT=codex-initial-8m6+FIRST+SECOND, replacing FIRST and SECOND with the exact text of the first and second follow-up messages. If either follow-up message is missing, reply exactly RESULT=missing. Do not include any other text.'
EXPECTED_RESULT='RESULT=codex-initial-8m6+codex-active-one-2p9+codex-active-two-6v1'

echo "--- Submitting Codex active-input smoke job ---"
if ! SUBMIT_OUTPUT=$(sudo "$BIN_DIR/runner" local submit \
  --group "$GROUP" \
  --timeout 240 \
  --cli-agent-type codex \
  --env OPENAI_MODEL=gpt-5.6-luna \
  --secret-env OPENAI_API_KEY="$OPENAI_API_KEY" \
  --prompt "$PROMPT" \
  --active-input 'after=100ms,text=codex-active-one-2p9' \
  --active-input 'after=300ms,text=codex-active-two-6v1' 2>&1); then
  echo "$SUBMIT_OUTPUT"
  print_service_logs
  fail "real Codex active-input local submit smoke failed"
fi
echo "$SUBMIT_OUTPUT"

SUBMIT_JSON="$(awk '/^\{/{line=$0} END{print line}' <<<"$SUBMIT_OUTPUT")"
[ -n "$SUBMIT_JSON" ] || fail "local submit output did not include a JSON response"
RUN_ID="$(jq -r '.run_id // empty' <<<"$SUBMIT_JSON")"
[ -n "$RUN_ID" ] || fail "local submit output did not include run_id"
STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${RUN_ID}.log"

print_failure_context() {
  echo "--- Guest stdout stream tail ---"
  sudo tail -200 "$STREAM_LOG" || true
  print_service_logs
}

if sudo grep -q 'Using mock-codex for testing' "$STREAM_LOG"; then
  print_failure_context
  fail "real Codex active-input smoke used mock Codex"
fi

sudo grep -F -q 'Codex active input steer:' "$STREAM_LOG" || {
  print_failure_context
  fail "Codex active-input smoke did not use turn/steer"
}

sudo grep -F -q 'outcome=active_turn_advanced' "$STREAM_LOG" || {
  print_failure_context
  fail "Codex active-input turn/steer did not report success"
}

echo "--- Real Codex active-input result lines from guest stdout ---"
sudo grep -E 'RESULT=|Codex active input steer|Codex Completed' "$STREAM_LOG" || true

sudo grep -F -q "$EXPECTED_RESULT" "$STREAM_LOG" || {
  print_failure_context
  fail "real Codex output did not include initial and active-input tokens"
}

echo "PASS: local active input reached real Codex and returned ${EXPECTED_RESULT}"
REMOTE_SCRIPT
} | ssh "$REMOTE" bash -s -- \
  "$BIN_DIR" \
  "$JOB_REF" \
  "$DEFAULT_ROOTFS_HASH" \
  "$DEFAULT_SNAPSHOT_HASH" \
  "$OFFICIAL_RUNNER_SECRET"
