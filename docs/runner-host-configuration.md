# Runner Host Configuration

## Diagnostic Host Attribution

`runner.yaml` may contain an optional `hostname` used only to identify the
physical runner in claims, sandbox telemetry, and Runner Axiom warning/error
events. Production automation writes the exact Ansible `inventory_hostname`;
it does not derive the value from DNS or the operating system at runtime.

The value must be non-empty and no longer than 255 JavaScript string units
(UTF-16 code units). `runner config --hostname <value>` validates and preserves
the raw value. Existing configuration files without `hostname` continue to
load and omit the canonical hostname fields.

Hostname does not select a service, directory, release, or rollback target.
Systemd service suffixes are opaque local instance names. Production currently
passes its explicit `runner_release` value as the service name and Runner
directory name, but version logic uses `runner_release` directly and does not
interpret a runner name as a version. Live processes are selected by their
exact config path and process identity, and rolling log files use the release
compiled into the Runner binary. Current Runner binaries send optional
canonical `runnerHostname` from configuration and canonical `runnerVersion`
compiled into the binary. They no longer send legacy `runnerName` in
heartbeats or sandbox telemetry. Current API revisions no longer declare,
persist, or map that field. During deployment overlap, an extra `runnerName`
from an older Runner payload is tolerated but discarded before request
handling.

Current `runner.yaml` has no legacy `name` field. Repository automation writes
`hostname` through `runner config`, while `--runner-dirname` and systemd service
`--name` remain opaque local lifecycle inputs. Live-runner records contain exact
config/process metadata and no legacy runner name. Readiness and doctor select
live processes by the unit's exact config path.

Operational queries and alerts should use `runner_hostname` and
`runner_version`. A bounded historical fallback may use `runner_name` only for
records that lack the canonical dimensions from before the cutover. Never
interpret `runner_name` as a hostname.

Runner Axiom warning/error events similarly include optional
`runner_hostname` and required `runner_version`. The rollout order is compatible
API and nullable heartbeat storage, Runner producer cutover, then logical API
receiver removal, followed by physical state-column removal after pre-cutover
serving API instances drained. The current schema no longer contains
`runner_state.runner_name`. Canary each transition and verify claim snapshots,
telemetry/Axiom dimensions, and distinct hostnames on two hosts running one
version. Remove any historical query fallback only after its bounded
observation window expires.

The runner reads host-local overrides from `/etc/vm0-runner/host.env` once
during startup. A missing file is equivalent to an empty file: the runner uses
`runner.yaml` for its concurrency factor and leaves I/O limiters disabled.

Apply file changes through the normal runner drain and restart workflow. A
running process does not reload this file.

## File Format

`host.env` is a runner-specific `KEY=VALUE` file. It is not sourced by a shell.
Blank lines and full-line comments are allowed, and whitespace around keys and
values is ignored:

```text
# Optional host-local concurrency override
OKOU_RUNNER_CONCURRENCY_FACTOR = 1.5
```

Do not use `export`, shell interpolation, quoted numeric values, or inline
comments. The parser accepts only the keys listed below. An unreadable file, a
line without `=`, an unsupported key, or a duplicate key is a configuration
error that prevents the runner from starting.

## Temporary Dual-Read Migration

The `OKOU_*` names are canonical. During the temporary dual-read stage, the
runner also accepts the corresponding legacy `VM0_*` alias for each logical
field:

| Canonical key                            | Temporary legacy alias                  | Unit                   | Valid values                               | Behavior                                                                                             |
| ---------------------------------------- | --------------------------------------- | ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `OKOU_RUNNER_CONCURRENCY_FACTOR`         | `VM0_RUNNER_CONCURRENCY_FACTOR`         | Dimensionless multiple | Positive finite number                     | Optional; overrides `sandbox.concurrency_factor` from `runner.yaml`. An invalid value fails startup. |
| `OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC` | `VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC` | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_DISK_IOPS`                  | `VM0_RUNNER_DISK_IOPS`                  | Operations/s           | Integer in `1..=u64::MAX`                  | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_NET_RX_MIB_PER_SEC`         | `VM0_RUNNER_NET_RX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_NET_TX_MIB_PER_SEC`         | `VM0_RUNNER_NET_TX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |

Use exactly one spelling for each field. If both aliases for the same field
appear, the runner fails startup even when their values are identical; the
error does not include either value. Different I/O fields may use different
spellings during migration, and they still form one all-or-none group after
alias normalization. A planned host cutover should rewrite all four I/O fields
to their canonical spelling in the same file update.

Do not change a deployed `host.env` to canonical names until every supported
runner and rollback target includes this dual reader. An older reader rejects
the canonical names as unsupported. Rolling back to an older reader therefore
requires atomically restoring the legacy spellings before starting the older
binary. Every file change still requires the normal runner drain and restart;
the running process does not reload it.

Every successful `host.env` load emits exactly one informational `runner host
environment loaded` event. Its dedicated tracing target, serialized to the
Axiom `context` field, is `runner::host_env::alias_sources`. The Runner Axiom
filter admits this exact informational target in addition to its existing
warning-and-error traffic; other informational events remain local. The event
contains these five fixed, value-free fields:

| Field                                     | Classification                     |
| ----------------------------------------- | ---------------------------------- |
| `concurrency_factor_alias_source`         | `absent`, `canonical`, or `legacy` |
| `disk_bandwidth_mib_per_sec_alias_source` | `absent`, `canonical`, or `legacy` |
| `disk_iops_alias_source`                  | `absent`, `canonical`, or `legacy` |
| `net_rx_mib_per_sec_alias_source`         | `absent`, `canonical`, or `legacy` |
| `net_tx_mib_per_sec_alias_source`         | `absent`, `canonical`, or `legacy` |

`absent` means the logical setting was omitted, `canonical` means the
`OKOU_*` spelling supplied it, and `legacy` means the `VM0_*` spelling supplied
it. Configured values, raw lines, and arbitrary input are never included.
`runner_hostname` and `runner_version` are added automatically by the Axiom
layer.

Before removing the temporary legacy readers, use this event to cover every
intended Runner host and supported rollback version for the full drain window.
Every field must remain either `canonical` or `absent`, with no `legacy`
classification during that window. A parse or alias-conflict failure emits no
successful-load event, so missing expected host coverage is a failed gate, not
evidence that the legacy spelling is absent.

Bandwidth values may be fractional. After conversion from MiB/s, the byte/s
value must be at least `1`, must fit in a `u64`, and is rounded down to an
integer. Disk IOPS must parse directly as a nonzero `u64`.

The concurrency override is independent of the I/O group, but it changes the
resource budget used to calculate the I/O limits.

## Configure Host I/O Capacity

The four I/O keys are one atomic configuration. Either omit all four or provide
all four:

```text
# Example sustainable aggregate host capacity; measure values for this host.
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
OKOU_RUNNER_DISK_IOPS=200000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=1250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=1000
```

These values describe sustainable total host capacity, not desired per-sandbox
rates and not short benchmark peaks. Every valid capacity is reduced by the
host reserve and divided among the maximum number of sandboxes the runner can
admit. Supplying per-sandbox targets here would reduce them again and could
throttle every sandbox below the intended rate.

A complete valid I/O configuration applies to every job on the runner. There
is no per-job feature switch.

## How The Runner Derives Limits

At startup, the runner:

1. Multiplies physical CPU and memory by the resolved concurrency factor to
   produce the effective resource budget.
2. Finds the maximum sandbox count that budget can admit across any mixture of
   configured profile CPU and memory shapes. A nonzero `max_concurrent` is an
   additional cap; `0` means there is no explicit job-count cap.
3. Uses that count as the denominator. For an unusually large calculation, it
   may use a conservative safe upper bound instead. The denominator is always
   at least one.
4. Reserves 20% of each configured host I/O capacity, then divides the remaining
   80% by the denominator using integer division.

For each capacity:

```text
usable host capacity = floor(host capacity * 80 / 100)
sandbox limit = floor(usable host capacity / denominator)
```

Bandwidth values are converted from MiB/s to bytes/s before this calculation.
The disk result is an aggregate sandbox-level block budget. Firecracker uses
per-drive limiters, so it divides that block budget evenly across the writable
drives attached to the sandbox. Network receive and transmit limits apply to
the sandbox network interface without another drive split.

If the calculated block budget cannot provide at least one byte/s and one
operation/s to each of two writable drives, or either network direction cannot
provide at least one byte/s, the entire I/O configuration is insufficient and
all I/O limiters are disabled.

### Worked Example

With the example values above and a resolved denominator of `4`, startup logs
show these sandbox-level limits:

| Capacity       | Host input     | Sandbox limit after reserve and division | Structured log field           |
| -------------- | -------------- | ---------------------------------------- | ------------------------------ |
| Disk bandwidth | `2000 MiB/s`   | `400 MiB/s` = `419430400 bytes/s`        | `disk_bandwidth_bytes_per_sec` |
| Disk IOPS      | `200000 ops/s` | `40000 ops/s`                            | `disk_ops_per_sec`             |
| Network RX     | `1250 MiB/s`   | `250 MiB/s` = `262144000 bytes/s`        | `net_rx_bytes_per_sec`         |
| Network TX     | `1000 MiB/s`   | `200 MiB/s` = `209715200 bytes/s`        | `net_tx_bytes_per_sec`         |

If a sandbox has two writable drives, Firecracker further splits the logged
disk budget into `209715200 bytes/s` and `20000 ops/s` for each drive.

## Failure Behavior

Host-file parsing and I/O resolution have different failure boundaries:

| Configuration state                                                       | Runner behavior                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File missing, or none of the four I/O keys present                        | Starts with I/O limiters disabled and logs `I/O limiters disabled`.                                                                              |
| All four logical I/O fields present and usable                            | Starts with all jobs limited and logs `I/O limiter capacity configured; applying limiters to all jobs`.                                          |
| I/O fields partial, numerically invalid, or insufficient after division   | Starts, logs `I/O limiter host env config invalid; disabling I/O limiter capacity` with a `reason`, and disables every disk and network limiter. |
| File unreadable, line malformed, key unsupported, or exact key duplicated | Fails startup with a runner configuration error.                                                                                                 |
| Both aliases for one logical field present                                | Fails startup with a value-free alias conflict error.                                                                                            |
| `OKOU_RUNNER_CONCURRENCY_FACTOR` or its legacy alias present but invalid  | Fails startup with a runner configuration error naming the canonical key and `host.env`.                                                         |

The non-fatal I/O warning is all-or-nothing. A valid disk pair does not stay
enabled when the network pair is missing or invalid, and vice versa.

## Verify The Effective Configuration

After applying the file through the normal restart workflow, inspect the runner
startup logs. For a named systemd service, use:

```bash
runner service logs --name <service-suffix> --lines 100
```

First find `resource budget initialized` and verify:

- `concurrency_factor` and `concurrency_factor_source`
- `max_concurrent`
- `effective_vcpu` and `effective_memory_mb`
- `profiles`

Then verify exactly one I/O resolution message:

- `I/O limiters disabled` when no capacity is configured;
- `I/O limiter host env config invalid; disabling I/O limiter capacity` and
  its `reason` when the I/O group is unusable; or
- `I/O limiter capacity configured; applying limiters to all jobs` when the
  group is active.

The configured message includes:

- `denominator`
- `disk_bandwidth_bytes_per_sec`
- `disk_ops_per_sec`
- `net_rx_bytes_per_sec`
- `net_tx_bytes_per_sec`

These are effective sandbox-level limits. The disk fields are logged before
the per-drive split.

## Implementation Sources

- [`crates/runner/src/host_env.rs`](../crates/runner/src/host_env.rs) defines
  the file path, allowed keys, and file parser.
- [`crates/runner/src/runtime_overrides.rs`](../crates/runner/src/runtime_overrides.rs)
  resolves the concurrency-factor override.
- [`crates/runner/src/resource_budget.rs`](../crates/runner/src/resource_budget.rs)
  defines the effective CPU and memory budget.
- [`crates/runner/src/io_limits.rs`](../crates/runner/src/io_limits.rs) validates
  host capacity and derives sandbox-level limits.
- [`crates/runner/src/cmd/start/mod.rs`](../crates/runner/src/cmd/start/mod.rs)
  emits the startup state and effective-limit logs.
- [`crates/sandbox-fc/src/config.rs`](../crates/sandbox-fc/src/config.rs) splits
  the sandbox block budget across Firecracker drives.
