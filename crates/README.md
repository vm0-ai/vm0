# Rust Crates for Firecracker VM

This workspace contains Rust crates for running code inside Firecracker microVMs.

## Crates

| Crate | Description |
|-------|-------------|
| **vsock-proto** | Protocol encoding/decoding shared by host and guest |
| **vsock-guest** | Guest-side agent — runs inside the VM, handles host commands |
| **vsock-host** | Host-side async client (tokio) — sends commands to the guest |
| **vsock-test** | End-to-end integration tests — real host + real guest over Unix sockets |
| **vm-init** | Init process (PID 1) for Firecracker VMs — filesystem setup, signal handling, vsock-guest |
| **vm-common** | Shared utilities for vm-init and vm-download |
| **vm-download** | Downloads and unpacks VM assets (kernel, rootfs, snapshots) |

## Architecture

```
┌──────────────────────────────────────────┐
│              Firecracker VM              │
│                                          │
│   vm-init (PID 1) + vsock-guest          │
│                  │                        │
│             vsock (CID=2, port=1000)     │
└──────────────────┼───────────────────────┘
                   │
┌──────────────────┼───────────────────────┐
│  Host (Runner)   │                        │
│     VsockHost (Rust) / VsockClient (TS)  │
└──────────────────────────────────────────┘
```

## Building

```bash
cargo build
cargo build --release
cargo build --release --target aarch64-unknown-linux-musl -p vm-init
```

## Testing

```bash
cargo test
cargo test -p vsock-test
```
