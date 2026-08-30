# Default-seed prepared baseline benchmark

This benchmark compares the current complete default-seed storage path with one
exact prepared sandbox on the same metal Runner. It is a local experiment. It
does not add a production baseline, pool, claim selector, API field, persisted
authority, or cross-thread reuse rule.

## Candidate ownership

The benchmark harness owns the candidate descriptor. The Runner's existing
storage fingerprints are not a candidate attestation: they record which storage
versions were last applied but do not prove that retained guest files remain
complete and unmodified.

The descriptor contains:

- the full `vm0-ai/vm0-skills` source commit;
- a deterministic checksum list and digest for `computer-use`, `gen`, and
  `workflow-setup`;
- the `claude-code` framework and its exact guest mount paths;
- the Runner profile;
- the Runner binary digest;
- the rootfs and snapshot identities; and
- a digest of the complete descriptor.

Changing any input invalidates the candidate. A parked sandbox intentionally
rejects `runner exec`, so the harness starts a controlled reuse turn whose mock
agent blocks without performing benchmark work. It waits for the Runner's real
agent-spawn boundary, checks the descriptor marker and every seed file with
`runner exec`, and only then releases that controlled turn. The attestation
duration is recorded separately and added to a candidate-ready comparison
proxy. This ordering avoids competing with the Runner's own pre-spawn vsock
operations.

The controlled checker is the only process allowed to observe an invalid
candidate. Missing, stale, incomplete, corrupt, or mismatched state rejects the
candidate; the harness creates a new reuse key and supplies the valid complete
manifest for the subsequent workload-shaped run. No production or arbitrary
workload is dispatched against the rejected state.

This validation is intentionally local and relatively expensive. It occurs
after the measured real-spawn boundary because the current Runner has no
pre-workload candidate-attestation hook. A future production design would need
an authoritative immutable or revalidated representation before granting the
candidate and must include that validation cost.

## Fixture

The worker fetches an explicit full Git commit from the public
`vm0-ai/vm0-skills` repository. It creates deterministic gzip-compressed tar
archives with sorted entries, epoch timestamps, and normalized numeric
ownership. The source commit is the fixture version; it is not a production VAS
version ID.

An isolated loopback server exposes the three archives and captures only this
Runner service's telemetry. The worker restarts the local Runner with its API
URL pointed at that sink, then restores the ordinary local development service
configuration during cleanup. Experiment telemetry is not sent to the normal
API.

## Paths and measurements

The worker runs three phases:

1. A cache warmup applies the complete manifest to a fresh sandbox.
2. The fresh cohort repeatedly uses a new reuse key, a cold sandbox, and the
   complete manifest with the same warm host archive cache.
3. The prepared cohort constructs one exact sandbox and repeatedly resumes it
   for controlled, blocking turns. Each turn reaches real agent spawn, is
   attested before release, and uses the unchanged complete manifest. Exact
   storage fingerprints make the storage plan no-work; the independent tree
   attestation determines whether the candidate may be accepted. The cohort
   stops and records a failure if the same candidate can no longer reach the
   real-spawn boundary.

Each successful sample records the complete local-submit-to-real-guest-spawn
`api_to_spawn` duration. This has the same Runner telemetry action name but its
start is the local queue publish boundary, not an HTTP API request. The worker
also records:

- storage apply, host cache/staging, and guest application;
- sandbox creation when present;
- the real guest-agent process spawn boundary;
- service CPU delta;
- candidate attestation duration;
- service current and peak memory;
- fixture and Runner logical and allocated disk; and
- terminal failure, cancellation, queue cleanup, and service cleanup evidence.

The report calculates p50, p90, p95, and p99 directly from complete per-sample
durations with nearest-rank percentiles. It also reports the fraction at or below
one second, sample range, mean, and failure count. In addition to the observed
`api_to_spawn` distribution, it reports a candidate-ready proxy computed per
sample as observed spawn plus that sample's attestation. It never sums or
subtracts independently aggregated component percentiles.

Exact prepared reuse avoids sandbox creation as well as storage application.
The reported whole-path difference is therefore relevant to a
prepared-pool-style direction and is not a storage-only causal estimate. Storage
and sandbox components remain separate in the output.

## Failure and invalidation probes

After the measured cohorts, the worker builds a separate exact candidate for
each invalidation probe and verifies:

- a missing candidate marker uses the fresh complete path;
- a stale descriptor uses the fresh complete path;
- a deleted seed file uses the fresh complete path;
- a modified seed file uses the fresh complete path;
- a changed fixture version/environment descriptor uses the fresh complete
  path;
- a missing current archive fails the complete path closed;
- a corrupt current archive fails the complete path closed; and
- cancellation reaches a terminal state without leaving local job, claim, or
  cancel ownership files.

Separate candidates prevent a measured sandbox's lifecycle failure or prior
mutation from contaminating the correctness probes. The first five cases have a
valid current manifest and test rejection of prepared state. The missing and
corrupt archive cases are different: the current authority itself is
unavailable, so the run fails instead of granting the rejected prepared files.

## Running on the configured metal host

Prepare and deploy the local Runner first:

```bash
scripts/dev-runner.sh deploy-local
```

Then run the benchmark. The default is 20 samples per measured cohort and the
checked-in known source revision. Both may be explicit:

```bash
scripts/dev-runner.sh storage-baseline-benchmark \
  20 \
  dc9bfc7a3c2faf607e2520d80c233792bf8f9249
```

The sample count must be between 1 and 100, and the source revision must be a
full lowercase 40-character commit. The command emits raw JSONL records followed
by one JSON summary. Capture that foreground output in ignored `codex-work/`
storage when evidence must be retained for an issue.

The worker always uses the deployed Runner binary, profile configuration,
rootfs, and snapshot already present on that host. It records their identities
in the metadata record so results from different revisions are not combined.

## Interpreting the gate

Compare the complete sample distributions with the parent gate: at least 25 ms
p90, two percentage points at the one-second boundary, or a material tail
improvement, with no material CPU, memory, disk, failure, cancellation, or
cleanup regression. A cohort that cannot complete its requested repeated
same-candidate samples is not failure-free even if its successful-sample
percentiles are faster.

A pass supports only a separate production-behavior issue. It does not make the
benchmark's local manifest, guest attestation, or retained sandbox a production
authority. A miss supports keeping complete per-run storage application.
