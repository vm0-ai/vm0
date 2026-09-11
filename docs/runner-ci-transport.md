# Runner CI transport

The Runner Image workflow uses private R2 for binary delivery and image readiness.
GitHub Actions still owns scheduling, producer identity, permissions, and job
status. Other workflows' reports, credentials, and CLI artifacts are unchanged.

## Delivery

1. The hosted `prepare` job computes each target's binary input digest and looks
   for a trusted reusable manifest. It checks the object's size with HEAD but
   does not download binaries. Its output contains only small per-target binary
   manifests; host maps remain in private storage.
2. Only cache misses start the Rust `compile` matrix. Each compiler validates the
   fresh Runner and Guest metadata, checks historical equal-input conflicts,
   compresses and publishes the binary to R2, and publishes its reusable record.
3. The hosted `build` matrix downloads only its target's selected binary. It
   verifies compressed size, decompressed size, and SHA-256 before using it. It
   then prepares images on all hosts of that architecture and publishes the
   validated image manifest.
4. Crates and Turbo wait for their target's authenticated image record and
   validate the exact build SHA, job reference, profile, target, and host set.
   An independently ready target remains usable if a sibling producer fails.

There is no separate binary asset job or GitHub artifact hop in this chain.
Recovery through `runner-binary-cache-plan.sh` still downloads and validates the
binary by default; only `RUNNER_BINARY_RESOLVE_MODE=reference` selects the
metadata-only planning path used by Runner Image.

## Integrity and producer authority

Compressed binaries retain their content-addressed key:
`runner-binaries/<target>/<runner-sha>.zst`. Conditional publication must verify
the retained object even when another producer has already written that key.

Manifests use the repository-scoped namespace:
`runner-ci/v1/<owner>/<repo>/<record-name>/<run-id>/<attempt>/<manifest-sha>.json`.
Records are bounded to 64 KiB, conditionally written, and read back before the
publisher exposes the SHA. A successful subsequent step named
`R2 record <manifest-sha>` records that exact hash in GitHub's canonical job
timeline. Readers verify those bytes against that receipt as well as the
canonical repository, workflow path, source SHA, run, and attempt.

R2 writer access or a self-declared `producer` field is not proof of origin.
Cache candidates must also satisfy the existing protected-main, same-PR, or
main-ancestry rules. Conflicting Runner or Guest identities for equal inputs
cause a cache miss; the fresh compiler's shadow comparison fails on a trusted
conflict. Historical discovery inspects at most eight records and ranks the
authenticated candidates according to the consumer event. Missing or unavailable
historical cache data allows fresh compilation, not unverified reuse.

Readers request all job attempts and use the newest execution of each job name.
A failed-only downstream rerun can reuse a successful producer that was not
rerun. Once that producer itself has a newer execution, its earlier receipt is
invalid even if the newer execution failed. Workflow-wide attempt equality would
incorrectly reject the first case.

## Failure and retention

R2 is a required delivery dependency. Fresh publication and selected binary
retrieval fail if they cannot be verified; they do not silently fall back to
GitHub artifacts. Each R2 client operation has a 120-second total bound and three
SDK attempts. Cache planning has a shorter 60-second per-target owner deadline;
image waiting preserves its existing deadline and GitHub rate-limit cooldowns.

Records expire for readers after seven days, based on both storage metadata and
the independently recorded GitHub receipt time. Refreshing an R2 timestamp cannot
renew an old producer receipt. The scheduled `cleanup-stale.yml` metadata job
deletes records older than fourteen days in batches of at most 1,000, with a
dry-run mode. It paginates past recent records and only accepts keys matching
this repository's new namespace and record grammar. Cleanup failures remain
visible. Bucket lifecycle administration is not required.

This cleanup does not delete `runner-binaries/` objects or change their existing
retention ownership. `Cache-Control` is a caching header, not a deletion policy.
Host-side binary and image cleanup also remains unchanged.

## Rollout and validation

Producer and consumer changes ship together in one workflow revision. Older
revisions continue their own GitHub artifact transport. New readers do not reuse
old artifact manifests, so their first lookup can compile from a cold cache.
There are no application, API, or Guest/Runner protocol changes.

Local shell integration tests exercise real files, hashes, and zstd bytes with
external GitHub/S3 fixtures. PR CI must additionally validate real private R2
access, resolved receipt step names in the GitHub jobs API, both architectures,
and downstream manifest delivery. Removing duplicate transfers is not itself a
measurement of end-to-end speedup; client installation and verification costs
must be included when comparing actual runs.
