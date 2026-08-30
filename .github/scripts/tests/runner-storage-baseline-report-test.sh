#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../../.." && pwd)
REPORT="$REPO_ROOT/.github/scripts/runner-storage-baseline-report.sh"

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

raw="$tmp/samples.jsonl"
for value in 700 900 1100 1300; do
  jq -cn \
    --argjson value "$value" \
    '{
      kind: "sample",
      cohort: "fresh",
      success: true,
      api_to_spawn_ms: $value,
      storage_apply_ms: 300,
      storage_cache_populate_ms: 80,
      storage_guest_download_ms: 200,
      sandbox_create_ms: 400,
      agent_spawn_ms: 10,
      cpu_usec: 1000,
      attestation_ms: null,
      candidate_ready_proxy_ms: $value
    }' >> "$raw"
done
for value in 600 700 800 900; do
  jq -cn \
    --argjson value "$value" \
    '{
      kind: "sample",
      cohort: "prepared",
      success: true,
      api_to_spawn_ms: $value,
      storage_apply_ms: 0,
      storage_cache_populate_ms: null,
      storage_guest_download_ms: null,
      sandbox_create_ms: null,
      agent_spawn_ms: 8,
      cpu_usec: 500,
      attestation_ms: 12,
      candidate_ready_proxy_ms: ($value + 12)
    }' >> "$raw"
done
jq -cn '{kind:"sample",cohort:"prepared",success:false,error:"bounded failure"}' >> "$raw"

bash "$REPORT" "$raw" > "$tmp/report.json"

jq -e '
  .schema_version == 2
  and .fresh.samples == 4
  and .fresh.api_to_spawn_ms.p50 == 900
  and .fresh.api_to_spawn_ms.p90 == 1300
  and (.fresh.api_to_spawn_ms.stddev | type) == "number"
  and .fresh.at_or_below_1s.count == 2
  and .fresh.at_or_below_1s.fraction == 0.5
  and .prepared.samples == 5
  and .prepared.successes == 4
  and .prepared.failures == 1
  and .prepared.api_to_spawn_ms.p90 == 900
  and .prepared.at_or_below_1s.fraction == 1
  and .prepared.attestation_ms.p95 == 12
  and .prepared.candidate_ready_proxy_ms.p90 == 912
  and .observed_total_path_delta.p90_ms == 400
  and .observed_total_path_delta.at_or_below_1s_percentage_points == 50
  and .candidate_gate_adjusted_delta.p90_ms == 388
  and .candidate_gate_adjusted_delta.at_or_below_1s_percentage_points == 50
  and (.candidate_gate_adjusted_delta.failure_free | not)
' "$tmp/report.json" >/dev/null

: > "$tmp/empty.jsonl"
if bash "$REPORT" "$tmp/empty.jsonl" >"$tmp/empty.out" 2>"$tmp/empty.err"; then
  echo "empty report input unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'sample file is empty' "$tmp/empty.err"

jq -cn '{kind:"sample",cohort:"fresh",success:true,api_to_spawn_ms:1}' \
  > "$tmp/missing.jsonl"
if bash "$REPORT" "$tmp/missing.jsonl" >"$tmp/missing.out" 2>"$tmp/missing.err"; then
  echo "missing prepared cohort unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'missing sample cohort: prepared' "$tmp/missing.err"

cat > "$tmp/telemetry.jsonl" <<'JSONL'
{"runId":"target","event":"guest-payload-without-operations"}
{"runId":"other","sandboxOperations":[{"action_type":"ignored"}]}
{"runId":"target","sandboxOperations":[{"action_type":"api_to_spawn","duration_ms":42}]}
JSONL
bash "$REPORT" --operations "$tmp/telemetry.jsonl" target > "$tmp/operations.json"
jq -e '
  length == 1
  and .[0].action_type == "api_to_spawn"
  and .[0].duration_ms == 42
' "$tmp/operations.json" >/dev/null

echo "runner-storage-baseline-report-test: ok"
