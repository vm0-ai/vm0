# Run preparation overlap measurement

These nested API dispatch operations establish an unchanged-schedule baseline for
[#32558](https://github.com/vm0-ai/vm0/issues/32558). They do not change run
preparation order or demonstrate a startup-latency improvement.

## Boundaries

| Operation                                                          | Complete boundary                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api_dispatch_prepare_context_select_connector_catalog`            | Runtime catalog selection, including empty and preloaded results                  |
| `api_dispatch_prepare_context_resolve_thread_connector_selections` | Thread connector account selection and validation, including the no-thread return |
| `api_dispatch_pre_create_agent_resolve_paused_thread_goal`         | Paused-goal lookup after successful session resolution                            |

Catalog selection, thread selection and the existing
`api_dispatch_prepare_context_resolve_model_provider` operation still start in
one all-settled wave. Connector-context loading still starts after all three
results pass their existing checks. Session resolution still precedes paused-goal
lookup, which remains inside each session-preparation retry.

The first two measurements include no-op paths; their presence does not imply a
database query or a nonempty connector scope. The goal measurement is absent
when the call is not reached, including runs without a thread.

The existing collector records at most two additional observations per reached
runtime wave and one per reached paused-goal lookup. They use its existing
batched flush, with no new queries, network requests or identifying dimensions.
There is a small timer and record-allocation cost; this instrumentation is not
itself a performance optimization.

## Cohort and correlation rules

1. Fix the observation window and record whether ingestion time was also fixed.
   Query bounded raw operation groups, checking result limits and late arrivals.
2. Join API operations and successful `api_to_spawn` records by `run_id`. Require
   one record per operation needed for the candidate and consistent API identity.
   Exclude missing, repeated or conflicting records; do not multiply joins or
   substitute zero for a missing measurement.
3. Stratify by exact `api_commit_sha`, the spawn's `runner_version` and
   `runner_startup_path`, `agent_run_origin`, `trigger_source`,
   `api_process_dispatch_ordinal_bucket` and `run_preparation_retry_count`.
   Do not pool different revisions or origins to satisfy a sample gate.
4. Exclude ambiguous preparation retries. The collector can accumulate repeated
   operations under the eventual run ID and attach final-flush retry metadata.
   That field does not uniquely label each recorded attempt. Neither array order
   nor summing repeated operations establishes a valid candidate pair.
5. API operation `_time` is its completion timestamp, not ingestion time or
   start time. `duration_ms` uses a monotonic clock, while `_time` has millisecond
   wall-clock precision. Reject contradictory timelines and disclose clock and
   rounding uncertainty; sub-millisecond finish-time differences are not precise
   overlap evidence.
6. Collector records use the existing `success: true` convention, including
   measurements recorded in `finally`. This is not an individual operation
   outcome or a fleet-wide failure denominator. Successful-spawn cohorts cannot
   establish startup failure rates.

## Candidate-specific ideal ceilings

Calculate each ceiling per run before computing percentiles. These calculations
assume unchanged operation costs without additional resource contention; they
are not measured improvements.

### Connector-context loading

Let `catalog_end` and `thread_end` be the two prerequisite completion timestamps,
`provider_end` the existing model-provider completion timestamp, and
`context_duration` the existing
`api_dispatch_prepare_context_load_connector_contexts` duration, all in
milliseconds.

```text
inputs_ready = max(catalog_end, thread_end)
provider_remaining = max(0, provider_end - inputs_ready)
ideal_overlap = min(context_duration, provider_remaining)
```

Do not use the entire provider duration as the proposed saving: catalog or thread
selection can finish later. Nested catalog substeps cannot replace the complete
prerequisite wrapper, especially for preloaded catalogs or catalog work performed
inside thread account selection. Provider-dependent framework, secret,
permission and usage materialization remain outside this overlap.

### Session resolution and paused-goal lookup

Use the same run's
`api_dispatch_pre_create_agent_resolve_thread_session` duration and the new
paused-goal duration:

```text
ideal_overlap = min(session_duration, paused_goal_duration)
```

Keep this candidate separate from connector loading. Session prompt construction
depends on the resolved session action and is not an independent read represented
by this ceiling. A query returning no paused goal still has a measured duration;
it does not authorize dropping the query or changing goal behavior.

## Decision gate

Report complete sample counts, exclusions and candidate-specific distributions.
Do not sum independent timing percentiles, represent these ceilings as observed
savings, or infer that every run benefits from both candidates.

Before retaining any scheduling change, compare it with the unchanged schedule
under representative concurrent API-entry runs. Report preparation latency,
p95/p99, query count, database pool-acquisition pressure, failures and measurement
noise. Preserve authorization, error/abort priority, fresh session retries,
materialized output and durable launch behavior. If a candidate lacks a justified
benefit, record its no-change decision instead of adding concurrency complexity.

The attribution PR alone does not close #32558: its deployment and the two
independent evidence-backed decisions remain required.
