# Runner Host Configuration

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
VM0_RUNNER_CONCURRENCY_FACTOR = 1.5
```

Do not use `export`, shell interpolation, quoted numeric values, or inline
comments. The parser accepts only the keys listed below. An unreadable file, a
line without `=`, an unsupported key, or a duplicate key is a configuration
error that prevents the runner from starting.

| Key                                     | Unit                   | Valid values                   | Behavior                                                                                             |
| --------------------------------------- | ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `VM0_RUNNER_CONCURRENCY_FACTOR`         | Dimensionless multiple | Positive finite number         | Optional; overrides `sandbox.concurrency_factor` from `runner.yaml`. An invalid value fails startup. |
| `VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC` | MiB/s                  | Positive finite decimal number | Required with the other three I/O keys.                                                              |
| `VM0_RUNNER_DISK_IOPS`                  | Operations/s           | Positive integer               | Required with the other three I/O keys.                                                              |
| `VM0_RUNNER_NET_RX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal number | Required with the other three I/O keys.                                                              |
| `VM0_RUNNER_NET_TX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal number | Required with the other three I/O keys.                                                              |

The concurrency override is independent of the I/O group, but it changes the
resource budget used to calculate the I/O limits.

## Configure Host I/O Capacity

The four I/O keys are one atomic configuration. Either omit all four or provide
all four:

```text
# Example sustainable aggregate host capacity; measure values for this host.
VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
VM0_RUNNER_DISK_IOPS=200000
VM0_RUNNER_NET_RX_MIB_PER_SEC=1250
VM0_RUNNER_NET_TX_MIB_PER_SEC=1000
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

| Configuration state                                                   | Runner behavior                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File missing, or none of the four I/O keys present                    | Starts with I/O limiters disabled and logs `I/O limiters disabled`.                                                                              |
| All four I/O keys present and usable                                  | Starts with all jobs limited and logs `I/O limiter capacity configured; applying limiters to all jobs`.                                          |
| I/O keys partial, numerically invalid, or insufficient after division | Starts, logs `I/O limiter host env config invalid; disabling I/O limiter capacity` with a `reason`, and disables every disk and network limiter. |
| File unreadable, line malformed, key unsupported, or key duplicated   | Fails startup with a runner configuration error.                                                                                                 |
| `VM0_RUNNER_CONCURRENCY_FACTOR` present but invalid                   | Fails startup with a runner configuration error naming the key and `host.env`.                                                                   |

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
