# Rust Crates

This workspace contains Rust crates for the vm0 sandbox runtime — VM orchestration, guest execution, vsock communication, and supporting services.

## Crates

| Crate | Description |
|-------|-------------|
| **runner** | Firecracker sandbox orchestrator — polls for jobs, manages VM lifecycle, and bridges API to sandbox-fc |
| **sandbox** | Sandbox trait and shared types — `SandboxConfig`, `ExecRequest`, `SandboxFactory` |
| **sandbox-fc** | Firecracker sandbox implementation — VM lifecycle, network namespace pool, overlay FS, snapshots |
| **vsock-proto** | Protocol encoding/decoding shared by host and guest |
| **vsock-host** | Host-side async client (tokio) — sends commands to the guest |
| **vsock-guest** | Guest-side agent — runs inside the VM, handles host commands |
| **vsock-test** | End-to-end integration tests — real host + real guest over Unix sockets |
| **guest-init** | Init process (PID 1) for Firecracker VMs — filesystem setup, signal handling, vsock-guest |
| **guest-agent** | Orchestrates CLI execution, heartbeat, telemetry upload, and checkpoint creation inside Firecracker VM |
| **guest-common** | Shared utilities for guest crates |
| **guest-download** | Downloads and extracts storage archives based on manifest — parallel downloads with retry logic |
| **guest-mock-claude** | Mock Claude CLI for testing — executes bash commands and outputs Claude-compatible JSONL |
| **ably-subscriber** | Ably Pub/Sub subscribe-only realtime client — WebSocket/MessagePack protocol with token auth and automatic reconnection |
| **reqeast** | Thin reqwest wrapper — auto-installs `ring` TLS crypto provider, avoiding `aws-lc-sys` musl cross-compilation issues |

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
│                 │                        │
│            sandbox (trait)               │
└──────────────────────────────────────────┘
```

## TLS in Guest Binaries

Guest crates (`guest-agent`, `guest-download`) **must** use system certificate roots, not bundled webpki roots. The host runs a mitmproxy transparent proxy that intercepts HTTPS traffic with its own CA certificate, which is installed into the guest's system certificate store at boot. Using bundled roots would bypass the proxy CA and cause TLS verification failures. As of reqwest 0.13, the `rustls` feature uses `rustls-platform-verifier` which reads from the system certificate store on Linux.

All crates that make HTTP requests should depend on **`reqeast`** (not `reqwest` directly). `reqeast` uses `ring` as the TLS crypto provider instead of `aws-lc-rs`, which is required for `aarch64-unknown-linux-musl` cross-compilation. See [`reqeast/README.md`](reqeast/README.md) for details.

## Building

```bash
cargo build
cargo build --release
cargo build --release --target aarch64-unknown-linux-musl -p guest-init
```

## Testing

```bash
cargo test
cargo test -p vsock-test
```
