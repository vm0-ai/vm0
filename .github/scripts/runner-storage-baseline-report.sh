#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = --operations ]; then
  TELEMETRY=${2:?Missing telemetry JSONL path}
  RUN_ID=${3:?Missing run ID}
  jq -cs --arg run_id "$RUN_ID" \
    '[.[] | select(.runId == $run_id) | (.sandboxOperations // [])[]]' \
    "$TELEMETRY"
  exit 0
fi

RAW_SAMPLES=${1:?Usage: runner-storage-baseline-report.sh <samples.jsonl>}

if [ ! -s "$RAW_SAMPLES" ]; then
  echo "Storage baseline sample file is empty: $RAW_SAMPLES" >&2
  exit 1
fi

jq -s '
  def nearest_rank($values; $percent):
    ($values | sort) as $sorted
    | if ($sorted | length) == 0 then null
      else $sorted[((($sorted | length) * $percent / 100) | ceil) - 1]
      end;

  def distribution($records; $field):
    [$records[] | .[$field] | select(type == "number")] as $values
    | if ($values | length) == 0 then null
      else (($values | add) / ($values | length)) as $mean
      | {
        count: ($values | length),
        min: ($values | min),
        max: ($values | max),
        mean: $mean,
        stddev: ($values | map(. - $mean | . * .) | add / length | sqrt),
        range: (($values | max) - ($values | min)),
        p50: nearest_rank($values; 50),
        p90: nearest_rank($values; 90),
        p95: nearest_rank($values; 95),
        p99: nearest_rank($values; 99)
      }
      end;

  def at_or_below_1s($records; $field):
    [$records[] | .[$field] | select(type == "number")] as $values
    | if ($values | length) == 0 then null
      else {
        count: ([$values[] | select(. <= 1000)] | length),
        fraction: (([$values[] | select(. <= 1000)] | length) / ($values | length))
      }
      end;

  def cohort($name):
    [ .[] | select(.kind == "sample" and .cohort == $name) ] as $records
    | if ($records | length) == 0 then error("missing sample cohort: \($name)")
      else [$records[] | select(.success == true)] as $successful
      | {
          cohort: $name,
          samples: ($records | length),
          successes: ($successful | length),
          failures: ([$records[] | select(.success != true)] | length),
          api_to_spawn_ms: distribution($successful; "api_to_spawn_ms"),
          storage_apply_ms: distribution($successful; "storage_apply_ms"),
          storage_cache_populate_ms: distribution($successful; "storage_cache_populate_ms"),
          storage_guest_download_ms: distribution($successful; "storage_guest_download_ms"),
          sandbox_create_ms: distribution($successful; "sandbox_create_ms"),
          agent_spawn_ms: distribution($successful; "agent_spawn_ms"),
          cpu_usec: distribution($successful; "cpu_usec"),
          candidate_gate_overhead_ms: distribution($successful; "candidate_gate_overhead_ms"),
          candidate_ready_proxy_ms: distribution($successful; "candidate_ready_proxy_ms"),
          at_or_below_1s: at_or_below_1s($successful; "api_to_spawn_ms"),
          candidate_ready_at_or_below_1s: at_or_below_1s($successful; "candidate_ready_proxy_ms")
        }
      end;

  cohort("fresh") as $fresh
  | cohort("prepared") as $prepared
  | {
      schema_version: 2,
      fresh: $fresh,
      prepared: $prepared,
      observed_total_path_delta: {
        p90_ms: (
          if $fresh.api_to_spawn_ms.p90 == null or $prepared.api_to_spawn_ms.p90 == null
          then null
          else $fresh.api_to_spawn_ms.p90 - $prepared.api_to_spawn_ms.p90
          end
        ),
        at_or_below_1s_percentage_points: (
          if $fresh.at_or_below_1s.fraction == null or $prepared.at_or_below_1s.fraction == null
          then null
          else 100 * ($prepared.at_or_below_1s.fraction - $fresh.at_or_below_1s.fraction)
          end
        )
      },
      candidate_gate_adjusted_delta: {
        p90_ms: (
          if $fresh.candidate_ready_proxy_ms.p90 == null or $prepared.candidate_ready_proxy_ms.p90 == null
          then null
          else $fresh.candidate_ready_proxy_ms.p90 - $prepared.candidate_ready_proxy_ms.p90
          end
        ),
        at_or_below_1s_percentage_points: (
          if $fresh.candidate_ready_at_or_below_1s.fraction == null or $prepared.candidate_ready_at_or_below_1s.fraction == null
          then null
          else 100 * ($prepared.candidate_ready_at_or_below_1s.fraction - $fresh.candidate_ready_at_or_below_1s.fraction)
          end
        ),
        failure_free: ($fresh.failures == 0 and $prepared.failures == 0)
      },
      interpretation: "Prepared exact reuse also avoids sandbox creation; observed api_to_spawn is not a storage-only estimate. candidate_gate_adjusted_delta uses paired controlled-turn completion as a conservative ready proxy, not a production timing boundary."
    }
' "$RAW_SAMPLES"
