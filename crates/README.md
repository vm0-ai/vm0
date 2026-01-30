# Rust Crates for Firecracker VM

This workspace contains Rust crates for running code inside Firecracker microVMs.

## Crates

### vm-init

The init process (PID 1) for Firecracker VMs. This binary is installed at `/sbin/vm-init` in the rootfs and specified via kernel boot args (`init=/sbin/vm-init`).

**Responsibilities:**

1. **Filesystem initialization** - Mounts squashfs (read-only base) and ext4 (read-write overlay), sets up overlayfs, and performs pivot_root
2. **PID 1 duties** - Signal forwarding and zombie process reaping
3. **Host communication** - Runs vsock-agent for host-guest IPC

### vsock-agent

A library and standalone binary for host-guest communication via vsock or Unix sockets.

**Binary Protocol:**

```
[4-byte length][1-byte type][4-byte seq][payload]
```

**Message Types:**

| Type | Direction | Description |
|------|-----------|-------------|
| 0x00 | G→H | ready - Agent is ready |
| 0x01 | H→G | ping - Keepalive request |
| 0x02 | G→H | pong - Keepalive response |
| 0x03 | H→G | exec - Execute command |
| 0x04 | G→H | exec_result - Command result |
| 0x05 | H→G | write_file - Write file |
| 0x06 | G→H | write_file_result - Write result |
| 0xFF | G→H | error - Error message |

## Building

```bash
# Debug build (for development/testing)
cargo build

# Release build (for production, optimized for size)
cargo build --release

# Cross-compile for ARM64 (production deployment)
cargo build --release --target aarch64-unknown-linux-musl -p vm-init
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Firecracker VM                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  vm-init (PID 1)                                      │  │
│  │   ├── init.rs    - Filesystem setup (overlayfs)       │  │
│  │   ├── pid1.rs    - Signal handling, zombie reaping    │  │
│  │   └── main.rs    - Orchestration + vsock-agent        │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                  │
│                      vsock (CID=2, port=1000)               │
│                           │                                  │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│  Host (Runner)            │                                  │
│                    VsockClient (TypeScript)                  │
└─────────────────────────────────────────────────────────────┘
```

## Testing

The vsock-agent binary supports `--unix-socket` flag for testing without actual vsock:

```bash
# Build for tests
cargo build -p vsock-agent

# Used by turbo/apps/runner tests
./target/debug/vsock-agent --unix-socket /tmp/test.sock
```

Protocol encoding/decoding and message handling tests are located in the TypeScript runner:

```
turbo/apps/runner/src/lib/firecracker/__tests__/vsock.test.ts
```

This tests the full Host ↔ Guest communication, verifying that messages encoded by TypeScript are correctly parsed by Rust and vice versa.

## Release Profile

Both crates are optimized for minimal binary size:

- `opt-level = "z"` - Optimize for size
- `lto = true` - Link-time optimization
- `strip = true` - Strip symbols
- `codegen-units = 1` - Better optimization at cost of compile time
