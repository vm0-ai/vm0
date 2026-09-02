# Okou CLI current identity

This document is the authoritative source, residual, and rollback record for
the completed Okou CLI identity cutover tracked by issues #26429 and #26431.

## Supported command boundary

The private commit-addressed package exports only `okou`, mapped to
`okou.js`. Current artifacts contain no duplicate `zero.js` payload, and the
retired executable name is unsupported. The artifact smoke test exercises the
real `okou --help` and `okou __agent-loop` boundaries and separately proves
that the retired name cannot resolve in a clean command environment.

Commander parsing, validation, output, HTTP construction, and exit behavior
remain covered through the canonical entry point. MSW stays at the production
HTTP boundary. The guest-agent process-boundary integration test asserts the
exact `npx`, package URL, `okou`, internal loop, and standby argv.

## Final removal gate

The final removal gate passed in the
[#26431 authorization record](https://github.com/vm0-ai/vm0/issues/26431#issuecomment-5264650228).
The owner explicitly superseded only the remaining elapsed-time wait; the live
production, source, durable-content, artifact, health, and rollback checks all
passed before implementation was authorized.

The recorded delivery and production evidence is:

- child A PR #26436 and release #26446 completed;
- child B PR #26491 and initial release #26506 completed;
- the latest fully released dual-entry rollback baseline is release #26540 at
  commit `a08e28cc84dc44a8f28db7571282aad2fd3c8d26`;
- production contained no Runner version that invoked the retired executable,
  and pre-cutoff pending, queued, running, finalizing, agent-run queue, and
  Runner-job queue state was zero;
- the complete finalization audit matched 184 starts to 184 successful terminal
  outcomes with no failed or cancelled finalization;
- the bounded production health audit exceeded the agreed success threshold
  for both agent and CLI execution and found no systemic Okou failure; and
- the supported durable source audit was clean at vm0-skills commit
  `68f64b677e935de2c5195e1df4683edbd2bdd18b`.

## Supported caller decision

All repository-controlled prompts, errors, skills, templates, workflows,
instructions, tests, operational commands, and Runner bootstrap paths use
Okou. The supported vm0-skills command tree also uses Okou; retired unsupported
command trees were removed in their owning repository.

Arbitrary user-owned persisted workflows, instructions, and templates are not
rewritten. A legacy executable string in that content is explicitly
unsupported until its owner deliberately migrates it. Historical execution
contexts retain their immutable commit-addressed artifact and are not rewritten.

## Preserved protocol identities

The executable cleanup does not rename internal protocol or product identities.
Keep `OKOU_TOKEN`, `OKOU_AGENT_ID`, the canonical `OKOU_*` names,
`commands/zero`, other `ZERO_*` names and `/api/zero/**`, database and backend
identifiers, the Slack `/zero model` interaction, and the separate Desktop
identity. These are not executable CLI producers.

`/api/okou/**` is not a preserved identity. It was a compatibility surface
drained under #26701, and #31088 emptied `MIGRATED_BRANDED_PATHS`, its last
holder. After #28984 no contract declares a branded path either, so nothing
registers one and every request to `/api/okou/**` or `/api/zero/**` is a 404.

The run-token scope pair was the one exception, retired separately once the
issuing side had drained; see `docs/okou-protocol-migration.md`.

## Exact residual classification

`.github/scripts/audit-okou-cli-cutover.sh` scans tracked and untracked
non-ignored current source, checks the guest-agent argv, and rejects indirect
binary exports, executable-path selection, artifact-verifier drift, legacy
success smoke coverage, workflow symlinks, and E2E wrapper selection. It prints
only category, file, and line or boundary name; it never prints arguments,
secrets, identifiers, or user content.

The final current-source result is:

`approved-internal-protocol=33 historical=241 unsupported-user-owned=0 unclassified=0`

The only allowed residual classes are:

- **Approved internal protocol:** the preserved identities listed above. They
  are not executable command producers.
- **Historical evidence:** changelogs, archived implementation notes, and
  immutable historical records and artifacts.
- **Explicitly unsupported user-owned content:** persisted user-authored text
  outside the tracked current source. It is not migrated automatically.

There is no compatibility-only or tracked executable test-fixture residual
class. Synthetic legacy commands are assembled only at audit-test runtime so
detection and redaction remain covered without storing an executable legacy
command in current source.

## Artifacts and rollback

Historical R2 artifacts are immutable and must not be changed or deleted. The
last known-good dual-entry rollback artifact is:

`https://static.vm0.io/okou-cli/a08e28cc84dc44a8f28db7571282aad2fd3c8d26/package.tgz`

Its package SHA-256 is
`2e822e4eda86a34f3794d79318369f2f0e43aa33d1b64fa07f2d72c866b7f67b`,
and its manifest SHA-256 is
`a43201ed1d9d86cb656ef5be9444af60dc4cbe9e4501123610f1d0ff7d515a9f`.

Rollback after an Okou-only release must restore that artifact selection
together with compatible post-B API, Runner, and guest-agent versions. Never
pair an Okou-invoking Runner with a pre-Okou artifact. Do not mutate or delete
Run, queue, workflow, audit, or historical artifact state during recovery.

The release owner must attach the final Okou-only production release, artifact,
and Runner-path evidence to #26431 and #26429 after this cleanup merges. Source
readiness does not itself claim that the final production release has happened.
