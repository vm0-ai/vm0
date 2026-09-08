# Input: one complete synthetic probe execution, parsed as JSON Lines with -s.
# Pair only this single-owner, serial stream. Never use ordinal pairing on fleet logs.
def quantiles:
  sort as $v
  | {p50: $v[(length * 0.50 | ceil) - 1],
     p90: $v[(length * 0.90 | ceil) - 1],
     p95: $v[(length * 0.95 | ceil) - 1],
     p99: $v[(length * 0.99 | ceil) - 1]};

def parse_phases:
  if . == "" then null else
    fromjson
    | ["cleanup_us", "containment_us", "io_setup_us", "join_us",
       "prepare_spawn_us", "wait_us"] as $coarse
    | ($coarse + ["prepare_us", "spawn_us"] | sort) as $refined
    | if type != "object" then error("phase diagnostics must be an object")
      elif (keys != $coarse and keys != $refined)
        or any(.[]; type != "number" or . < 0) then
        error("phase diagnostics must contain the complete nonnegative numeric phase set")
      else . end
  end;

def summarize_group:
  . as $group
  | {shape: .[0].shape, phase: .[0].phase,
     batch: (map(.batch) | unique | if length == 1 then .[0] else null end),
     count: length, phase_samples: (map(select(.diagnostic != "")) | length),
     milliseconds: (["outer_ms", "guest_ms", "inner_ms", "outer_minus_inner_ms",
                     "outer_minus_guest_ms", "guest_minus_inner_ms"]
       | map(. as $key | {key: $key, value: ($group | map(.[$key]) | quantiles)})
       | from_entries),
     phases_us: ($group | map(.phase_timings | select(. != null))
       | if length == 0 then null else
           . as $phases | .[0] | keys
           | map(. as $key | {key: $key, value: ($phases | map(.[$key]) | quantiles)})
           | from_entries
         end)};

map(select(.kind == "storage_probe")) as $outer
| map(select(.kind == "storage_probe_inner")) as $inner
| ([["cached-instructions", "first", 0, 0]]
   + [range(0; 3) as $b
      | (range(0; 100) | ["cached-instructions", "repeated", $b, .]),
        ["cached-instructions", "resumed", $b, 0]]
   + ["high-work", "oversized" | . as $shape
      | range(0; 10) | [$shape, "repeated", 0, .]]) as $expected
| if ($outer | length) != 324 or ($inner | length) != 324 then
    error("incomplete execution: expected exactly 324 outer and 324 child observations")
  elif ($outer | map([.shape, .phase, .batch, .index])) != $expected then
    error("unexpected sample order, duplicate, or mixed execution")
  elif any($outer[]; .success != true or .stdout_truncated != false
      or .stderr_truncated != false or (.outer_us | type) != "number"
      or (.guest_ms | type) != "number" or .outer_us < 0 or .guest_ms < 0)
    or any($inner[]; .success != true or (.duration_ms | type) != "number" or .duration_ms < 0) then
    error("failed, truncated, or missing timing observations; do not summarize as a successful cohort")
  else . end
| [range(0; 324) as $i
   | $outer[$i] + {inner_ms: $inner[$i].duration_ms}
   | . + {phase_timings: (.diagnostic | parse_phases)}
   | . + {outer_ms: (.outer_us / 1000),
          outer_minus_inner_ms: (.outer_us / 1000 - .inner_ms),
          outer_minus_guest_ms: (.outer_us / 1000 - .guest_ms),
          guest_minus_inner_ms: (.guest_ms - .inner_ms)}] as $pairs
| if ($pairs | map(.phase_timings | select(. != null) | keys) | unique | length) > 1 then
    error("mixed diagnostic builds in one execution")
  else . end
| {attempts: 324, complete_inner_pairs: 324, failures: 0,
   groups: ($pairs | group_by([.shape, .phase, .batch]) | map(summarize_group)),
   by_shape_phase: ($pairs | group_by([.shape, .phase]) | map(summarize_group))}
