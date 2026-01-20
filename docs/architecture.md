# VM0 Architecture

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
  - [Compute](#compute)
  - [Storage](#storage)
  - [Orchestration](#orchestration)
- [Infrastructure](#infrastructure)
  - [E2B Sandbox Backend](#e2b-sandbox-backend)
  - [Firecracker Sandbox Backend](#firecracker-sandbox-backend)
  - [Cloudflare R2 Object Storage](#cloudflare-r2-object-storage)
- [References](#references)

---

## Overview

VM0 is a platform for running AI agent workflows in isolated sandbox environments. The platform consists of three core subsystems:

1. **Compute**: Sandbox execution (E2B or Firecracker microVMs)
2. **Storage**: User data persistence (Cloudflare R2)
3. **Orchestration**: Job queue and runner coordination (PostgreSQL)

### High-Level Architecture

**Execution Flow**:
```
User CLI/API Request
  ↓
Web API (Next.js)
  ↓
Executor Selection (E2B or Runner)
  ↓
Compute Layer (Sandbox)
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

#### Two Execution Backends

**1. E2B (Default)**
- Third-party managed sandbox service (e2b.dev)
- Container-based isolation
- Template system for environment configuration
- 24-hour timeout (production), 1-hour (development)
- Fire-and-forget execution with webhook callbacks

**2. Firecracker (Experimental)**
- Self-hosted microVMs on bare metal Linux
- Hardware-level isolation via KVM
- 3-5 second boot time
- Network namespace isolation per VM
- Requires runner infrastructure

#### Executor Selection

```
if experimental_runner.group specified:
  → Queue job in runner_job_queue
  → Firecracker runner polls and executes
else:
  → Execute immediately via E2B
```

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

**Runner Behavior**:
1. Poll `/api/runners/poll` every 5 seconds (configurable)
2. Receive pending job: `{ runId, prompt, agentComposeVersionId }`
3. Claim job atomically via `/api/runners/claim` (sets `claimed_at`)
4. Execute in Firecracker VM
5. Report completion via webhook
6. Job deleted from queue

#### Runner Groups

**Format**: `{scope}/{name}`
- Official: `vm0/*` (e.g., `vm0/production`) - VM0-managed runners
- User: `{userid}/*` (e.g., `user123/private`) - Self-hosted runners

**Authentication**:
- Official runners: HMAC signature using `OFFICIAL_RUNNER_SECRET`
- User runners: JWT bearer token with userId claim

---

## Infrastructure

### E2B Sandbox Backend

E2B (e2b.dev) is a third-party managed sandbox service that provides containerized execution environments.

#### Integration

- SDK: `@e2b/code-interpreter`
- Template: Specified via `E2B_TEMPLATE_NAME` environment variable or `agent.image` in `vm0.yaml`
- Authentication: `E2B_API_KEY`

#### Execution Flow

1. Create sandbox with environment variables
2. Upload Python/Node.js scripts via tar bundle
3. Download storages from R2 via presigned URLs
4. Restore session history (for resume)
5. Start agent CLI in background (nohup)
6. Webhook reports progress and completion

---

### Firecracker Sandbox Backend

Firecracker is an open-source VMM (Virtual Machine Monitor) developed by AWS that creates lightweight microVMs using Linux KVM.

#### Infrastructure Requirements

**Hardware**:
- Bare metal Linux server
- KVM support: `/dev/kvm` device
- Cannot run on cloud VMs (nested virtualization limitations)

**Software**:
- Firecracker v1.10.1 binary
- Linux kernel v6.1.102 (for microVM)
- Node.js 24.x, pnpm, pm2
- mitmproxy (network observability)
- Docker (rootfs build only)

#### Architecture

**Runner Application**: Separate Node.js application in `turbo/apps/runner/`

**VM Configuration**:
```yaml
# runner.yaml
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.squashfs

sandbox:
  vcpu: 2
  memory_mb: 2048
  max_concurrent: 1
```

#### Storage Architecture

**Shared Read-Only Base**:
- Squashfs rootfs (~500MB-1GB compressed)
- Location: `/opt/firecracker/rootfs.squashfs`
- Shared across all VMs
- Built from Dockerfile via `build-rootfs.sh`

**Per-VM Writable Overlay**:
- Sparse ext4 (2GB, allocates on write)
- Location: `/tmp/vm0-vm-{vmId}/overlay.ext4`
- Combined with base via overlayfs (custom init script)
- Enables instant boot without rootfs copy

#### Network Architecture

**Isolation**: Each VM in separate network namespace

**TAP Device**: One per VM
- Name: `vm0tap{vmId}` (e.g., `vm0tap12345678`)
- Layer 2 Ethernet virtualization
- Bridges host and guest

**IP Allocation**: 172.16.x.x/30 subnets
- Host IP: .1 (e.g., 172.16.161.177)
- Guest IP: .2 (e.g., 172.16.161.178)
- 4 IPs total per VM: network, host, guest, broadcast

**Internet Access**: NAT via iptables on runner host

**HTTP Proxy**: mitmproxy at host:8080
- Intercepts all HTTP/HTTPS traffic
- Logs requests/responses
- Firewall enforcement (experimental)
- CA certificate injected into VM trust store

#### Execution Flow

1. Runner polls for jobs (5s interval)
2. Creates Firecracker VM (3-5s boot)
3. SSH to VM (using runner's key)
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
- [E2B](https://e2b.dev)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [mitmproxy](https://mitmproxy.org/)

### Community

- [Documentation](https://docs.vm0.ai)
- [Discord](https://discord.gg/WMpAmHFfp6)
- [GitHub](https://github.com/vm0-ai/vm0)
