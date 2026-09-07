# Rust Crates

This workspace contains 28 Rust crates for sandbox orchestration, guest execution,
control and RPC services, shared contracts, and developer/test support.

## Crates

| Crate                    | Responsibility                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| runner                   | Host-side run orchestration, sandbox lifecycle, proxy, images and operational CLI                     |
| sandbox                  | Provider-neutral sandbox interfaces and shared lifecycle/control types                                |
| sandbox-firecracker      | Firecracker provider: VM lifecycle, networking, NBD COW and snapshot restore                          |
| sandbox-mock             | Test implementation of the sandbox interfaces                                                         |
| nbd-cow                  | Userspace Linux NBD block devices with copy-on-write storage                                          |
| guest-control-proto      | Wire messages and codecs for controlling guest operations                                             |
| guest-control-client     | Runner-side guest-control caller, response dispatch and operation tracking                            |
| guest-control-server     | Guest control service embedded by guest-init in its child process                                     |
| guest-control-tests      | Real client/server integration tests over Unix sockets and executable fixtures                        |
| runner-rpc-proto         | Bounded framing and stream contracts for calls to Runner services                                     |
| runner-rpc-client        | Guest-side Runner RPC caller/helper, without business-method dispatch                                 |
| process-control-ipc      | Guest-local process control, Unix transport and descriptor handoff                                    |
| guest-init               | Guest PID 1 initialization, signal supervision and child reaping                                      |
| guest-agent              | Agent CLI lifecycle, heartbeat, events, checkpoints and session management                            |
| guest-tool-exec          | Tool hook adaptation and placement-before-exec launcher                                               |
| guest-storage-apply      | Storage/artifact manifest application: cleanup, preparation, extraction and instruction normalization |
| guest-state-restore      | Entropy/clock restoration and timezone configuration, including timezone-only mode                    |
| guest-write-file         | Direct stdin-to-file writes, including private and batch modes                                        |
| session-history-selector | Selects retained native history candidates without rewriting live sessions                            |
| claude-mock              | Claude test double, currently emitting CLI JSONL and session artifacts                                |
| codex-mock               | Codex test double, currently implementing app-server JSON-RPC and session artifacts                   |
| guest-contracts          | Shared Runner/guest runtime agreements, paths and filesystem helpers                                  |
| api-contracts            | TypeScript-owned API bindings and shared decoding/route helpers                                       |
| guest-telemetry          | Structured guest logging and operation telemetry                                                      |
| ably-subscriber          | Subscribe-only Ably client with authentication and connection recovery                                |
| shell-quote              | POSIX shell argument quoting                                                                          |
| tracing-test-support     | Structured tracing capture for tests                                                                  |
| xtask                    | Workspace developer checks, invoked through the cargo xtask alias                                     |

## Architecture and naming

```text
Runner -> guest-control-client -> guest-control-server (guest-init child)
Guest  -> runner-rpc-client    -> Runner service endpoint
Guest  -> process-control-ipc  -> guest-local process control / placement
```

Client/server names describe application calling roles, not socket initiation.
The guest opens the guest-control connection; Runner accepts it and calls guest
operations. The transport remains vsock forwarded through Firecracker Unix
sockets (or direct Unix sockets in integration tests). These services do not
implement a generic vsock protocol. Runner uses sandbox-firecracker through the
sandbox interfaces; guest-init remains PID 1 and embeds the control service in
its child. No new daemon or crate boundary is implied by these names.

A `guest-` package prefix is not an artifact inventory. The authoritative
[guest binary inventory](runner/guest-binaries.json) separately records each
package, binary, build environment key and installed path.

### Source, executable and release identities

Cargo package/directory/import names describe source responsibilities. Existing
executable names, installed paths, CLI flags and bootstrap environment variables
remain stable. The following renamed executable packages retain their binary contracts:

| Cargo package       | Executable        |
| ------------------- | ----------------- |
| runner-rpc-client   | guest-rpc         |
| guest-storage-apply | guest-download    |
| guest-state-restore | guest-reseed      |
| claude-mock         | guest-mock-claude |
| codex-mock          | guest-mock-codex  |

For example, `cargo build -p runner-rpc-client` still produces `guest-rpc`,
installed at `/usr/local/bin/guest-rpc`. The five renamed guest executable
packages declare explicit Cargo binary targets. Release configuration and
workflow output keys use the new directory paths. Renamed crates use their new
Cargo names as default release components and future tag prefixes, without
old-name component overrides. Manifest path keys move with unchanged numeric
versions; Release Please continues from those versions when new-name tags do not
yet exist. Historical tags and changelog entries are unchanged. The first release
under a new name may have a comparison link to a nonexistent new-name prior tag.
Existing unrelated component overrides (such as runner-rs and api-contracts-rs)
remain unchanged.

Explicit runtime log tags and operation labels remain stable. Implicit Rust
tracing targets follow the new underscore-form crate names; local filters that
name those modules must use the new names.

## Runner Operations

- [Host configuration and I/O capacity](../docs/runner-host-configuration.md):
  configure host-local concurrency and aggregate I/O capacity overrides.
- [Multi-architecture rollout](../docs/runner-multi-architecture.md): select,
  build, deploy, and validate architecture-specific runner artifacts.

## nbd-cow Benchmark

The `nbd-cow` benchmark compares NBD COW with dm-snapshot using fio workloads. It is an opt-in,
feature-gated benchmark that must run as root on a host with the required device tooling.

Run it from the repository root:

```bash
cargo run --manifest-path crates/Cargo.toml -p nbd-cow --features bench --bin bench -- [base-size-mb]
```

`base-size-mb` is optional. It specifies the base image size in MB, defaults to 1024 MB, and must
be at least 1024 MB (inclusive).

Before running the benchmark, ensure that:

- the process runs as root;
- `fio`, `losetup`, and `dmsetup` are available on `PATH`; and
- the NBD kernel module is loaded:

  ```bash
  modprobe nbd nbds_max=4096
  ```

## Logging

Runner Rust logs are recorded to local files, stderr, and CI at `info` and
above by default. Axiom ingests `warn` and above. Use `debug` or `trace` only
for local diagnostics that are acceptable to miss in production logs.

## TLS in Guest Binaries

Guest crates (`guest-agent`, `guest-storage-apply`) **must** use system certificate roots, not bundled webpki roots. The host runs a mitmproxy transparent proxy that intercepts HTTPS traffic with its own CA certificate, which is installed into the guest's system certificate store at boot. Using bundled roots would bypass the proxy CA and cause TLS verification failures.

Both HTTP clients in the workspace use `rustls-platform-verifier` to read from the system certificate store:

- **`reqwest`** (async) — used by `guest-agent`, `runner`, `ably-subscriber` with the `rustls` feature (aws-lc-rs crypto provider auto-installed).
- **`ureq`** (sync, no tokio) — used by `guest-storage-apply` with the `platform-verifier` feature. Uses `ring` by default.

## Building

```bash
# Native build
cargo build
cargo build --release

# Cross-compile with the faster CI/dev profile.
# Supported targets:
#   aarch64-unknown-linux-musl
#   x86_64-unknown-linux-musl
TARGET_TRIPLE=aarch64-unknown-linux-musl

# Step 1: build guest binaries
cargo build --target "$TARGET_TRIPLE" \
  -p guest-agent -p guest-storage-apply -p guest-init -p claude-mock -p codex-mock -p guest-state-restore -p guest-tool-exec -p guest-write-file -p runner-rpc-client \
  --profile ci

# Step 2: build runner with embedded guests
GUEST_AGENT_PATH="target/$TARGET_TRIPLE/ci/guest-agent" \
GUEST_DOWNLOAD_PATH="target/$TARGET_TRIPLE/ci/guest-download" \
GUEST_INIT_PATH="target/$TARGET_TRIPLE/ci/guest-init" \
GUEST_MOCK_CLAUDE_PATH="target/$TARGET_TRIPLE/ci/guest-mock-claude" \
GUEST_MOCK_CODEX_PATH="target/$TARGET_TRIPLE/ci/guest-mock-codex" \
GUEST_RESEED_PATH="target/$TARGET_TRIPLE/ci/guest-reseed" \
GUEST_TOOL_EXEC_PATH="target/$TARGET_TRIPLE/ci/guest-tool-exec" \
GUEST_WRITE_FILE_PATH="target/$TARGET_TRIPLE/ci/guest-write-file" \
GUEST_RPC_PATH="target/$TARGET_TRIPLE/ci/guest-rpc" \
cargo build --target "$TARGET_TRIPLE" -p runner --profile ci
```

## Testing

Use the `local` profile for routine local validation. Omit it when full debug information or
incremental compilation is more useful.

```bash
cargo test --profile local
cargo clippy --profile local --all-targets
```
