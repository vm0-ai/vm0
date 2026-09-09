# Guest DNS readiness attribution

The authoritative readiness interval is
`runner_fresh_sandbox_start_guest_dns_readiness`. It includes all attempts inside
one sandbox start and observation overhead, and retains its existing success and
failure semantics. Failure diagnostics and sandbox destruction happen afterward.
Readiness still completes before real Agent process spawn.

## Attempt records

`runner_fresh_sandbox_start_guest_dns_readiness_attempt` is a child event, emitted
at most three times per readiness invocation. Each event contains its own timing
pair; never join separate operations by timestamp to manufacture a pair.

| Field                             | Meaning                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `duration_ms`                     | Host request/response and validation elapsed time, in integer milliseconds |
| `dns_readiness_attempt`           | One-based attempt ordinal, from 1 to 3 within this invocation              |
| `dns_readiness_final_attempt`     | This invocation ends after this attempt, including cancellation            |
| `dns_readiness_guest_duration_ms` | Optional existing guest-reported helper lifecycle duration                 |
| `dns_readiness_host_residual_ms`  | Optional host duration minus guest duration from this same attempt         |
| `dns_readiness_timing`            | `paired`, `unavailable`, or `inconsistent`                                 |
| `outcome`                         | Bounded attempt result, not the outcome of the whole start                 |

Outcome values are `success`, `deadline`, `transport`, `process_timeout`,
`process_cancelled`, `start_failed`, `wait_failed`, `exit_nonzero`,
`output_truncated`, `unexpected_answer`, and `host_cancelled`. Unsuccessful
attempts also use that same bounded classification in `error`; arbitrary resolver
diagnostics, output, hostnames, exit codes and additional identities are not sent.

The guest timer starts before resolver process setup and ends after process and
descendant cleanup and output collection. It does **not** measure only DNS wire
latency. Earlier guest worker dispatch and response encoding/writing lie outside
this timer. The host residual includes those costs plus host request processing,
queueing and transport; it is **not** pure network latency either.

Both durations use process-local monotonic clocks. Subtraction uses their integer
millisecond durations, not timestamps from different clocks. Values have
millisecond quantization; a zero residual does not establish zero overhead.

`paired` means a valid result supplied a guest duration no greater than the host
duration. Only those rows have a residual. `inconsistent` retains the returned
guest duration but omits the invalid residual. `unavailable` omits both guest and
residual measurements, as on a request deadline, invalid/absent result or host
cancellation. Missing measurements must not be replaced with zero. Actual zero
durations and `false` final-attempt values are preserved by the API.

## Retry, cancellation and nesting

Attempts remain sequential, with the existing three-attempt limit, 1.1-second
child timeout, 2.1-second request allowance and seven-second overall retry budget.
The retry classification and requirement that a complete attempt fits the
remaining budget are unchanged. Measurements use a preallocated buffer bounded
to three entries and are replayed when the invocation ends, so callbacks do not run
between retry decisions. Event timestamps are captured at attempt completion,
before that replay; wall time is only used to place events.

Dropping an in-progress readiness future preserves completed attempts and adds
an incomplete `host_cancelled` attempt. Its host duration ends at cancellation;
it does not include later guest cleanup. The existing parent can be absent on
cancellation. No completed parent is synthesized, and recording does not own or
change connection fencing, cancellation or process cleanup.

The Runner may separately destroy and replace a DNS-unready sandbox under its
existing policy. Each replacement start has a new readiness invocation and its
ordinal restarts at one, even for the same run. This is not a fourth DNS attempt.
An attempt's `success: false` followed by success must not be counted as a failed
run. Parent/child durations nest: do not add attempts to their parent, or add
independently ranked percentiles.

## Rollout and analysis

These are optional fields on the existing telemetry webhook. The guest protocol,
API route, authentication and persisted state are unchanged. The new API accepts
old operations without these fields. An older API accepts the operation but
strips unknown optional measurements. That overlap loses attribution coverage,
not run correctness; require a containing API revision for analysis.

For a fixed observation window and exact API/Runner revision pair, report:

- Applicable starts and completed readiness parents, including failed starts;
- Attempt rows, observed invocations (attempt 1), final-attempt counts and outcome
  distributions, distinguishing inner retries from sandbox replacement;
- Coverage and unavailable/inconsistent/cancelled rows, without filling gaps;
- Parent and per-attempt host/guest/residual p50/p90/p95/p99 from raw observations,
  restricting residual percentiles to valid pairs;
- True cold, workspace, and blank/reuse paths separately, plus instrumentation
  and resource overhead for controlled comparisons.

Missing events or successful-start-only cohorts cannot establish failure rates.
Local measurements do not establish production coverage or a removable latency
budget. Issue #32445 retains the fixed-revision production report and subsequent
optimization/no-change decision after rollout; this instrumentation alone does
not complete parent #24203.
