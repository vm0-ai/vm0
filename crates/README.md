# Rust Crates

This workspace contains Rust crates for the vm0 sandbox runtime — VM orchestration, guest execution, vsock communication, and supporting services.

## Crates

| Crate | Description |
|-------|-------------|
| **runner** | Sandbox orchestrator — polls for jobs (API or local queue), manages VM lifecycle, proxy, service install, and bridges to sandbox-fc |
| **sandbox** | Sandbox trait and shared types — `SandboxFactory`, `Sandbox`, `SandboxConfig`, `ExecRequest`, `ExecResult` |
| **sandbox-fc** | Firecracker sandbox implementation — VM lifecycle, network namespace pool, NBD COW, snapshot restore |
| **nbd-cow** | Userspace NBD COW device — block-level copy-on-write via Linux NBD, bitmap tracking, no dm-snapshot/loop devices |
| **vsock-proto** | Wire protocol encoding/decoding shared by host and guest — length-prefixed binary messages |
| **vsock-host** | Host-side async vsock client (tokio) — connects to guest via Unix domain sockets |
| **vsock-guest** | Guest-side vsock library — IPC over vsock/Unix sockets, embedded in guest-init as PID 2 |
| **vsock-test** | Integration tests for vsock — real host + real guest over Unix sockets |
| **guest-init** | Init process (PID 1) for Firecracker VMs — virtual filesystem setup, env config, signal handling, forks vsock-guest |
| **guest-agent** | Guest orchestrator — CLI execution, heartbeat, telemetry upload, and checkpoint creation inside the VM |
| **guest-common** | Shared utilities for guest crates — logging macros, telemetry recording, environment accessors |
| **guest-download** | Downloads and extracts storage archives — parallel downloads (4 concurrent), streaming extraction, retry logic |
| **guest-mock-claude** | Mock Claude CLI for testing — executes bash commands and outputs Claude-compatible JSONL |
| **guest-mock-codex** | Mock Codex CLI for testing — emits Codex JSONL protocol on stdout and persists zstd-compressed session files |
| **guest-reseed** | Entropy reseed after snapshot restore — injects host entropy via RNDADDENTROPY and forces CRNG reseed via RNDRESEEDCRNG |
| **guest-write-file** | Direct file writer for vsock `write_file` — writes stdin to guest files without shell startup overhead |
| **ably-subscriber** | Ably Pub/Sub subscribe-only realtime client — WebSocket/MessagePack protocol with token auth and automatic reconnection |

## Architecture

```
┌──────────────────────────────────────────┐
│              Firecracker VM              │
│                                          │
│   guest-agent ── guest-download          │
│       │                                  │
│   guest-init (PID 1) + vsock-guest       │
│                  │                       │
│             vsock (CID=2, port=1000)     │
└──────────────────┼───────────────────────┘
                   │
┌──────────────────┼───────────────────────┐
│  Host            │                       │
│                  │                       │
│  runner ── sandbox-fc ── vsock-host      │
│    │             │                       │
│    │        sandbox (trait)              │
│    │        nbd-cow (NBD COW)             │
│    │                                     │
│    ├── ably-subscriber (job polling)     │
│    └── mitmproxy (HTTPS interception)    │
└──────────────────────────────────────────┘
```

## TLS in Guest Binaries

Guest crates (`guest-agent`, `guest-download`) **must** use system certificate roots, not bundled webpki roots. The host runs a mitmproxy transparent proxy that intercepts HTTPS traffic with its own CA certificate, which is installed into the guest's system certificate store at boot. Using bundled roots would bypass the proxy CA and cause TLS verification failures.

Both HTTP clients in the workspace use `rustls-platform-verifier` to read from the system certificate store:

- **`reqwest`** (async) — used by `guest-agent`, `runner`, `ably-subscriber` with the `rustls` feature (aws-lc-rs crypto provider auto-installed).
- **`ureq`** (sync, no tokio) — used by `guest-download` with the `platform-verifier` feature. Uses `ring` by default.

## Building

```bash
# Native build
cargo build
cargo build --release

# Cross-compile for aarch64 with the faster CI/dev profile
# Step 1: build guest binaries
cargo build --target aarch64-unknown-linux-musl \
  -p guest-agent -p guest-download -p guest-init -p guest-mock-claude -p guest-mock-codex -p guest-reseed -p guest-write-file \
  --profile ci

# Step 2: build runner with embedded guests
GUEST_AGENT_PATH=target/aarch64-unknown-linux-musl/ci/guest-agent \
GUEST_DOWNLOAD_PATH=target/aarch64-unknown-linux-musl/ci/guest-download \
GUEST_INIT_PATH=target/aarch64-unknown-linux-musl/ci/guest-init \
GUEST_MOCK_CLAUDE_PATH=target/aarch64-unknown-linux-musl/ci/guest-mock-claude \
GUEST_MOCK_CODEX_PATH=target/aarch64-unknown-linux-musl/ci/guest-mock-codex \
GUEST_RESEED_PATH=target/aarch64-unknown-linux-musl/ci/guest-reseed \
GUEST_WRITE_FILE_PATH=target/aarch64-unknown-linux-musl/ci/guest-write-file \
cargo build --target aarch64-unknown-linux-musl -p runner --profile ci
```

## Testing

```bash
cargo test
cargo clippy --all-targets
```
