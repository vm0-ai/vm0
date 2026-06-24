# Runner Multi-Architecture Rollout

This document describes the operational contract for running vm0 runners on
more than one host CPU architecture.

## Core Invariant

Runner host architecture determines every architecture-specific runner output:

- Rust target triple
- Runner image manifest target
- Release asset name
- Deploy, promote, and rollback asset
- Host-bound test target

Do not choose these values independently in workflows. Use the shared helper
scripts so CI, release, deploy, rollback, and local development keep the same
mapping.

## Supported Targets

`.github/scripts/runner-image-target.sh` is the implementation source of truth
for supported runner targets and derived metadata.

| Host `uname -m` | Rust target triple           | Cache suffix   | Release asset suffix | Release asset                      |
| --------------- | ---------------------------- | -------------- | -------------------- | ---------------------------------- |
| `aarch64`       | `aarch64-unknown-linux-musl` | `aarch64-musl` | `aarch64-linux`      | `runner-v${VERSION}-aarch64-linux` |
| `x86_64`        | `x86_64-unknown-linux-musl`  | `x86_64-musl`  | `x86_64-linux`       | `runner-v${VERSION}-x86_64-linux`  |

Runner release tags use `runner-rs-v${VERSION}`. Runner release assets use
`runner-v${VERSION}-${assetSuffix}`.

## Host Inventory

`AWS_METAL_RUNNER_HOSTS` is the single metal runner inventory for this rollout.
There is no separate architecture-specific host secret.

`.github/scripts/runner-host-architecture-groups.sh` derives architecture
groups by probing each host with SSH:

```bash
ssh "${METAL_USER}@${host}" uname -m
```

The helper accepts the configured host inventory and emits architecture groups
for the supported target triples. Unsupported host architectures fail early.

The full local contract includes host lists and is intended for same-job use:

- `id`
- `label`
- `hosts`
- `target`
- `unameM`
- `cacheSuffix`
- `assetSuffix`

The cross-job matrix contract is sanitized and excludes host lists:

- `id`
- `label`
- `target`
- `unameM`
- `cacheSuffix`
- `assetSuffix`

The deploy and rollback target matrix contains only:

- `id`
- `label`
- `target`

Host lists must not be passed through GitHub Actions job outputs or matrix JSON.
Jobs that need concrete hosts resolve them locally for the selected group:

```bash
.github/scripts/runner-host-architecture-groups.sh hosts "$RUNNER_HOST_GROUP_ID"
```

Jobs that need one representative host use the deterministic selector:

```bash
.github/scripts/runner-host-architecture-groups.sh select-host "$RUNNER_HOST_GROUP_ID" "$JOB_REF" "$HOSTS"
```

## Workflow Consumers

Runner image production resolves architecture groups, builds one runner image per
configured group, and validates the manifest under that group's target triple.

Crates host-bound tests resolve the same sanitized matrix and run architecture
specific checks, including NBD COW tests, on matching metal. Jobs that need an
actual host resolve the host subset inside the job instead of reading hosts from
the matrix.

Turbo runner consumers use the same metal inventory for runner bootstrap and
runner E2E jobs. These jobs validate behavior against the configured runner
fleet, but heavy behavior suites do not need to be duplicated per architecture
unless they assert architecture-specific behavior.

Release publishing builds runner assets for all supported target triples. The
asset names come from `.github/scripts/runner-image-target.sh`.

Production build, promote, and rollback resolve the deploy/rollback target
matrix from the configured inventory. Each matrix leg downloads or uses the
runner binary matching that group's target and passes `runner_target` to Ansible.

Ansible deploy and rollback validate the remote host architecture before
installing, promoting, or rolling back a runner binary. A target and remote
architecture mismatch should fail before mutating the runner service.

## Local Development

`scripts/dev-runner.sh` derives the runner target from the remote host
architecture by default.

Set `RUNNER_TARGET_TRIPLE` only when you need to force a supported target. The
script validates that the forced target matches the remote host `uname -m` before
building and uploading the runner.

## Dispatch Boundary

Current runner dispatch is not architecture-aware. The mixed-architecture rollout
selects the correct binary and image artifacts for each runner host, but it does
not guarantee that a profile or run always lands on a fixed CPU architecture.

Workspace and sandbox reuse are runner-local, so a local workspace is not shared
across different runner machines. If the product needs fixed-architecture
scheduling semantics later, that should be handled as a separate control-plane
design.

## Validation Checklist

Record dated validation evidence in the rollout issue or PR, grouped by
architecture group. Do not mark an architecture as runtime-validated solely
because cross-compilation or release asset publication succeeded.

For each configured architecture group, record evidence for:

| Area                      | Evidence to record                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Runner image production   | The matrix leg built the image and uploaded a target-specific manifest.                          |
| Runner image consumption  | Consumers resolved the matching target-specific manifest.                                        |
| NBD COW tests             | Host-bound NBD COW tests ran on matching metal.                                                  |
| Runner setup              | `runner setup` downloaded and verified Firecracker, kernel, and mitmdump artifacts.              |
| Rootfs and snapshot       | `runner build --profile vm0/default` built the template, rootfs, and snapshot on matching metal. |
| Snapshot restore          | A sandbox restored from the snapshot successfully.                                               |
| Local runner smoke        | A local runner claimed and completed a smoke job.                                                |
| Guest CLIs                | Chromium, Claude Code, Codex, Node global packages, PostgreSQL, Go, and Rust work in the rootfs. |
| Release asset             | The expected `runner-v${VERSION}-${assetSuffix}` asset exists.                                   |
| Deploy, promote, rollback | The host used the matching asset and passed architecture preflight.                              |

If a host architecture is not configured in `AWS_METAL_RUNNER_HOSTS`, record that
state explicitly instead of marking the architecture complete.
