#!/usr/bin/env bash
set -euo pipefail

summary="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/summary.jq"

fixture() {
  jq -nc '
    def outer($shape; $phase; $batch; $index):
      {kind: "storage_probe", shape: $shape, phase: $phase, batch: $batch,
       index: $index, outer_us: (2000 + $index), guest_ms: 1, success: true,
       stdout_truncated: false, stderr_truncated: false, diagnostic: ""};
    outer("cached-instructions"; "first"; 0; 0),
    (range(0; 3) as $b
     | (range(0; 100) | outer("cached-instructions"; "repeated"; $b; .)),
       outer("cached-instructions"; "resumed"; $b; 0)),
    ("high-work", "oversized" | . as $shape
     | range(0; 10) | outer($shape; "repeated"; 0; .)),
    (range(0; 324) | {kind: "storage_probe_inner", duration_ms: 0, success: true})'
}

fixture | jq -s -f "$summary" | jq -e '
  .attempts == 324 and .complete_inner_pairs == 324 and .failures == 0
  and (.groups | length) == 9
  and (.by_shape_phase | length) == 5
  and ([.by_shape_phase[] | select(.shape == "cached-instructions" and .phase == "repeated")
    | .count == 300 and .batch == null and .milliseconds.outer_ms.p90 == 2.089] | all)
  and ([.groups[] | select(.shape == "cached-instructions" and .phase == "repeated")
    | .count == 100 and .phase_samples == 0 and .phases_us == null
      and .milliseconds.outer_ms == {p50: 2.049, p90: 2.089, p95: 2.094, p99: 2.098}
      and .milliseconds.outer_minus_inner_ms == .milliseconds.outer_ms] | all)' >/dev/null

fixture | jq 'if .kind == "storage_probe" then
  .diagnostic = ({cleanup_us: 10, containment_us: 20, io_setup_us: 30,
    join_us: 40, prepare_spawn_us: 50, wait_us: 60} | tojson) else . end' \
  | jq -s -f "$summary" | jq -e '
    [.groups[] | .phase_samples == .count and .phases_us.wait_us.p90 == 60] | all' >/dev/null

reject() {
  local mutation=$1
  if fixture | jq -s "$mutation | .[]" | jq -s -f "$summary" >/dev/null 2>&1; then
    echo "unexpectedly accepted invalid evidence: $mutation" >&2
    return 1
  fi
}

reject '.[0].success = false'
reject '.[0].stdout_truncated = true'
reject '.[0].guest_ms = null'
reject '.[0].outer_us = -1'
reject '.[324].duration_ms = null'
reject '.[324].success = false'
reject '.[1].index = 1'
reject '.[0].diagnostic = "malformed"'
reject '.[0].diagnostic = "{\"spawn_us\":null}"'
reject '.[0].diagnostic = "{}"'
reject '.[0].diagnostic = "[]"'
reject '.[0].diagnostic = ({cleanup_us: 10, containment_us: 20, io_setup_us: 30, join_us: 40, prepare_spawn_us: 50, wait_us: "60"} | tojson)'
reject '.[0].diagnostic = ({cleanup_us: 10, containment_us: 20, io_setup_us: 30, join_us: 40, prepare_spawn_us: 50, wait_us: 60} | tojson) | .[1].diagnostic = (.[0].diagnostic | fromjson | . + {prepare_us: 10, spawn_us: 40} | tojson)'
reject '.[0:647]'

echo 'PASS: complete-pair quantiles and invalid-evidence rejection'
