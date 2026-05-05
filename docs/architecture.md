# VM0 Architecture

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
  - [Compute](#compute)
  - [Storage](#storage)
  - [Orchestration](#orchestration)
- [Infrastructure](#infrastructure)
  - [Firecracker Sandbox Backend](#firecracker-sandbox-backend)
  - [Cloudflare R2 Object Storage](#cloudflare-r2-object-storage)
- [References](#references)

---

## Overview

VM0 is a platform for running AI agent workflows in isolated sandbox environments. The platform consists of three core subsystems:

1. **Compute**: Sandbox execution (Firecracker microVMs)
2. **Storage**: User data persistence (Cloudflare R2)
3. **Orchestration**: Job queue and runner coordination (PostgreSQL)

### High-Level Architecture

**Execution Flow**:
```
User CLI/API Request
  ↓
Web API (Next.js)
  ↓
Runner Executor (job queue)
  ↓
Compute Layer (Firecracker microVM)
  ↓ (downloads from)
Storage Layer (R2)
  ↓ (reports via webhooks)
Web API
  ↓
User receives results
```

---

## System Architecture

### Compute

The compute layer executes agent workflows in isolated sandbox environments.

#### Execution Backend: Firecracker

- Self-hosted microVMs on bare metal Linux
- Hardware-level isolation via KVM
- 3-5 second boot time
- Network namespace isolation per VM
- Jobs queued in `runner_job_queue`, runners poll and execute

---

### Storage

The storage layer persists user data (volumes, artifacts, session state) in Cloudflare R2.

#### Storage Types

**Volumes**: Read-only data mounted at specified paths
- Examples: Code repositories, dependencies, reference data
- Defined in `vm0.yaml`

**Artifacts**: Read-write working directory
- Agent output, modified files, generated assets
- Versioned after each run
- Used for checkpoints and resume

#### Data Flow

**Upload**:
```
CLI → tar.gz archive → presigned PUT URL → R2
Database records: storage_id, version_id, s3_key
```

**Download**:
```
Server → presigned GET URL (1h expiration)
  ↓
Storage manifest JSON → Sandbox
  ↓
Sandbox downloads directly from R2 (no API proxy)
  ↓
Extracts to mount paths
```

---

### Orchestration

The orchestration layer coordinates job execution between web API and runners.

**Job Notification**:
- **Wakeup**: Ably realtime notifications wake runners for instant HTTP polling (~100-200ms)
- **Fallback**: HTTP polling every 30s catches missed notifications

**Runner Behavior**:
1. Subscribe to Ably channel `runner-group:{org}/{name}`
2. Receive job notification and wake HTTP poll
3. Select the next job via `/api/runners/poll`
4. Claim job atomically via `/api/runners/jobs/{id}/claim` (sets `claimed_at`)
5. Execute in Firecracker VM
6. Report completion via webhook
7. Job deleted from queue

#### Runner Groups

**Format**: `{org}/{name}`
- Official: `vm0/*` (e.g., `vm0/production`) - VM0-managed runners
- User: `{org-slug}/*` (e.g., `my-team/private`) - Self-hosted runners

**Authentication**:
- Official runners: HMAC signature using `OFFICIAL_RUNNER_SECRET`
- User runners: JWT bearer token with userId claim

---

## Infrastructure

### Firecracker Sandbox Backend

Firecracker is an open-source VMM (Virtual Machine Monitor) developed by AWS that creates lightweight microVMs using Linux KVM.

#### Infrastructure Requirements

**Hardware**:
- Bare metal Linux server
- KVM support: `/dev/kvm` device
- Cannot run on cloud VMs (nested virtualization limitations)

**Software**:
- Firecracker v1.14.1 binary
- Linux kernel v6.1.155 (for microVM)
- Node.js 24.x, pnpm, pm2
- mitmproxy (network observability)
- debootstrap (rootfs build only)

#### Architecture

**Runner Application**: Rust application in `crates/runner/`

**VM Configuration**:
```yaml
# runner.yaml
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux

sandbox:
  vcpu: 2
  memory_mb: 2048
  max_concurrent: 1
```

#### Storage Architecture

**Shared Read-Only Base**:
- ext4 rootfs (~500MB-1GB)
- Content-addressed: `/var/lib/vm0-runner/images/{rootfs_hash}/rootfs.ext4`
- Shared across all VMs via nbd-cow
- Built via debootstrap + chroot in `build-template.sh`, then customized with
  guest binaries and host-specific settings in `customize-rootfs.sh`

**Per-VM Copy-on-Write (nbd-cow)**:
- Userspace NBD-based COW backed by sparse file
- Device: `/dev/nbdN` (writable block device)
- Reads of unmodified blocks go to base image, writes captured in COW file
- Enables instant boot without rootfs copy

#### Network Architecture

**Isolation**: Each VM in separate network namespace via pre-warmed namespace pool

**Namespace Pool**: Pre-allocated network namespaces for fast VM startup
- Each namespace gets a unique veth pair
- Namespace side: `veth0` (e.g., `10.200.0.2`)
- Host side: `vm0-ve-{pool}-{index}` (e.g., `vm0-ve-00-00`)
- Pool supports up to 64 pools × 256 namespaces

**IP Allocation**: 10.200.0.0/16 subnets
- Guest fixed IP: `192.168.241.2` (same across VMs, isolated by namespace)
- NAT/MASQUERADE: Guest traffic routed through namespace to external network

**HTTP Proxy**: mitmproxy (dynamically allocated port)
- Intercepts all HTTP/HTTPS traffic
- Logs requests/responses to per-run JSONL files
- CA certificate injected into VM trust store
- Proxy registry: `{base_dir}/proxy-registry.json` (flock-based coordination)

#### Execution Flow

1. Runner selects job via HTTP poll, woken by Ably notification or 30s polling fallback
2. Creates Firecracker VM (3-5s boot)
3. Vsock connection to guest agent
4. Upload scripts, configure DNS, install proxy CA
5. Preflight check (curl to heartbeat endpoint)
6. Download storages from R2
7. Start agent CLI in background
8. Webhook reports progress
9. VM terminated on completion

---

### Cloudflare R2 Object Storage

Cloudflare R2 is S3-compatible object storage with zero egress fees.

#### Configuration

- Endpoint: `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
- Bucket: `R2_USER_STORAGES_BUCKET_NAME`
- SDK: `@aws-sdk/client-s3` with S3-compatible API
- Region: Auto (global)

#### Storage Format

- Archives: tar.gz compressed
- S3 keys: Content-addressed by SHA-256 hash
- Presigned URLs: 1-hour expiration for GET/PUT

#### Direct Download

Sandboxes download directly from R2 (no proxy through VM0 API):
1. VM0 API generates presigned GET URLs
2. Storage manifest JSON uploaded to sandbox
3. Sandbox's `download.mjs` script fetches from R2
4. Parallel downloads for multiple archives

---

## References

### External

- [Firecracker](https://github.com/firecracker-microvm/firecracker)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [mitmproxy](https://mitmproxy.org/)

### Community

- [Discord](https://discord.gg/WMpAmHFfp6)
- [GitHub](https://github.com/vm0-ai/vm0)
