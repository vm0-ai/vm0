# Scoped connector projection cache observations

The `api_dispatch_connector_catalog_load_runtime_snapshot` event includes
`connector_catalog_projection_cache_observation` after a ready authoritative
projection identity has been read. This is diagnostic request history; it does
not change the selection cache, permissions, fallback behavior, or database work.

## Interpretation

Each API process tracks the 16 most recently observed distinct selection keys for
its last observed full projection identity. The key is the cache's existing
normalized identity plus **both** runtime and metadata connector sets, preserving
their separate roles. A repeated key moves to the front of the history.

| Value                   | Meaning at lookup time, before updating history                                  |
| ----------------------- | -------------------------------------------------------------------------------- |
| `first_observation`     | First ready projection lookup observed by this process                           |
| `identity_changed`      | Full projection identity differs from the previous observation; history is reset |
| `not_in_recent_history` | Exact key is absent from the current 16-key window                               |
| `reuse_1`               | Exact key is the most recently observed distinct key                             |
| `reuse_2`               | Exact key is the second most recent distinct key                                 |
| `reuse_3_4`             | Exact key is at MRU rank 3–4                                                     |
| `reuse_5_8`             | Exact key is at MRU rank 5–8                                                     |
| `reuse_9_16`            | Exact key is at MRU rank 9–16                                                    |

MRU rank is one plus the number of distinct other keys observed since that key's
previous lookup, not elapsed time or total intervening requests. All ready
lookups contribute, including callers without a timing collector. An identity
transition includes source, projection generation, catalog, and capability
changes. Concurrent identity reads can observe different generations in either
order: this field reports transitions, not a count of global catalog updates.

Use the field alongside `connector_catalog_projection_cache_outcome` and
`connector_catalog_runtime_selection_source`. For example, a projection `miss`
with `reuse_2` demonstrates recent repeated scope use despite a cache miss. It
does **not** prove a two-entry payload cache would hit: earlier lookups may have
failed, fallen back, or still be in flight, and completion order can differ from
lookup order. The observer never changes pending-work ownership or completion
state.

`first_observation` is not a Vercel cold-start indicator. `not_in_recent_history`
does not mean never used before. Old API builds and fallback paths without a
ready identity omit the field; missing is not zero reuse. Fallback after a ready
lookup can carry an observation, so separate it from projection-source results.
Failed dispatches may not flush a run-associated event; this field is not a
failure-rate denominator.

## Resource and privacy boundary

Only one identity digest and up to 16 selection digests are retained, each a
64-character SHA-256 hexadecimal string: at most 1,088 characters plus bounded
array/object overhead. No additional connector payloads, credentials, raw keys,
or permission decisions are retained. Digests never leave process memory; the
new log dimension has exactly eight possible values. Hash collisions could
affect diagnostics, never cache lookup or authorization.

Each ready lookup adds two local hashes and a search over at most 16 entries,
with no I/O. This measurement window is not a chosen payload-cache capacity and
does not measure retained catalog graph size.

## Evaluation procedure

This instrumentation is the evidence slice of [#32570](https://github.com/vm0-ai/vm0/issues/32570)
under [#32557](https://github.com/vm0-ai/vm0/issues/32557) and
[#24203](https://github.com/vm0-ai/vm0/issues/24203). It is not a delivered latency
improvement.

1. Freeze an explicit UTC query interval in `vm0-sandbox-op-log-prod`. Report
   counts with and without the new field, grouped by full `api_commit_sha`,
   `agent_run_origin`, process age/dispatch ordinal buckets, selection source,
   and cache outcome. Do not infer absence of reuse from old builds.
2. Join load events to successful `api_to_spawn` events by `run_id` to obtain
   `runner_version` and the actual startup/reuse cohort. Keep exact API/Runner
   pairs separate, with a unique relevant event of each type per run. Report
   missing joins and exclude/report duplicates before multiway joins; do not
   pool revisions to reach a sample threshold.
3. Within each pair/cohort, report the observation distribution and catalog-load
   duration mean/P50/P90/P95/P99 for projection-source misses, hits, and in-flight
   reuse separately. Compare first observations and identity transitions with
   recent-reuse misses. Distance buckets are opportunity evidence, not a
   hypothetical cache hit ratio or per-run savings forecast.
4. For the parent's latency assessment, join the matching unique queue and
   `runner_claim_to_spawn` boundaries to each run before calculating intervals.
   API-start-to-claim-return is `api_to_spawn - runner_claim_to_spawn` for the same
   run. Report pre-queue and end-to-end durations, sample coverage, p95/p99, and
   the fraction of starts at or below 1,000 ms. Never add or subtract independently
   aggregated percentiles. Use independent dispatch/failure records to report
   failed or unspawned runs rather than treating this successful join as all runs.
5. If repeated exact scopes are material, measure representative retained
   selection objects and compare an unchanged baseline with a separately
   reviewed cache candidate. Select entry/byte/in-flight bounds using that
   evidence. Record allocation, retained heap, database calls/pressure, failures,
   and tail latency. Require improvement beyond noise and exact-version rollout
   validation before calling the parent complete; otherwise record no-change.

Keep the parent open after merging this evidence slice. Revisit the measurement
after the cache decision and remove it if it no longer supports an active need.
