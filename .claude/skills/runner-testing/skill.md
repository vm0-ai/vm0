---
name: runner-testing
description: Test runner profiles and VM sandbox on metal hosts using dev-runner.sh (deploy-local, submit, exec)
context: fork
---

# Runner Testing Skill

Test Firecracker VM sandbox profiles on metal hosts using local mode (file queue) with mock Claude.

## Quick Reference

```bash
# Deploy runner in local mode (file queue + mock Claude)
pnpm runner:local

# Submit a job with specific profile
pnpm runner:submit <profile> "<prompt>"

# Execute command in a running VM
pnpm runner:exec <run-id-prefix> <command>

# Restore normal API mode when done
pnpm runner

# Remove runner from host
pnpm runner:remove
```

## Architecture

```
dev-runner.sh deploy-local
  -> cross-compile runner + guests (aarch64-musl)
  -> upload to metal host via cf-ssh
  -> runner setup / gc / build rootfs+snapshot
  -> runner service start --local --env USE_MOCK_CLAUDE=true

dev-runner.sh submit <profile> <prompt>
  -> runner local submit --group <group> --profile <profile> --prompt <prompt>
  -> file queue: writes .job file, runner picks up, spawns VM
  -> mock-claude executes prompt as bash, outputs Claude-compatible JSONL
  -> returns JSON: {"run_id":"...","exit_code":0,"error":null}
```

### Token/Auth Flow (normal API mode)

Web API generates sandbox JWT -> runner receives in `ExecutionContext.sandboxToken` -> passed to VM as `VM0_API_TOKEN` env var -> guest-agent adds `Authorization: Bearer <token>` to webhook requests.

In local mode, webhooks go nowhere (no web server), but VM execution still works with mock Claude.

## Profile

| Profile | vCPU | RAM | Use Case |
|---------|------|-----|----------|
| `vm0/default` | 2 | 2048 MB | CLI agent, code generation, browser automation |

Profile definitions: `crates/runner/src/profile.rs`
Runner config on host: `/var/lib/vm0-runner/runners/<name>/runner.yaml`

## Testing Workflow

### 1. Deploy in Local Mode

```bash
cd turbo && pnpm runner:local
```

This builds, uploads, and starts the runner with `--local` (file queue) and `USE_MOCK_CLAUDE=true`.

### 2. Submit Test Jobs

```bash
# Basic resource check
pnpm runner:submit vm0/default "nproc && free -m"

# Browser profile with Chromium
pnpm runner:submit vm0/default "agent-browser navigate https://example.com --screenshot /tmp/test.png && free -m"

# Multiple pages to stress test memory
pnpm runner:submit vm0/default "agent-browser navigate https://news.ycombinator.com --screenshot /tmp/hn.png && agent-browser navigate https://github.com --screenshot /tmp/gh.png && free -m"
```

### 3. Check Results

Job logs are stored on the metal host:

```bash
# System log (guest-agent output including command results)
scripts/cf-ssh.sh <host> -- 'sudo cat /var/lib/vm0-runner/logs/system-<run-id>.log'

# Network log (mitmproxy HTTP activity)
scripts/cf-ssh.sh <host> -- 'sudo cat /var/lib/vm0-runner/logs/network-<run-id>.jsonl'

# Runner service log
scripts/cf-ssh.sh <host> -- 'journalctl -u vm0-runner-<name> --since "5 minutes ago"'
```

### 4. Restore Normal Mode

```bash
pnpm runner
```

## Resource Budget

Runner uses resource-based admission control (`crates/runner/src/resource_budget.rs`):

- Budget = host CPU/RAM * `concurrency_factor` (default 1.0)
- Each job reserves its profile's vCPU + memory_mb
- First job always admitted (even if exceeds budget)
- `max_concurrent` = 0 means no count cap (resource-limited only)

Example: 16 vCPU / 32 GB host can run:
- 8x default (16 vCPU / 16 GB)

## Debugging

### SSH to Metal Host

```bash
scripts/cf-ssh.sh <host> [-- <command>]

# Examples
scripts/cf-ssh.sh local-1.aws.vm3.ai -- 'sudo cat /var/lib/vm0-runner/runners/<name>/status.json'
scripts/cf-ssh.sh local-1.aws.vm3.ai -- 'nproc && free -m'
```

### Common Issues

#### Exit Code 1: "Not logged in"
Mock Claude not enabled. Ensure `--env USE_MOCK_CLAUDE=true` is passed to `service start`. The `deploy-local` command does this automatically.

#### Exit Code 92: curl fails with HTTP/2 stream error
Usually mitmproxy upstream TLS verification failure. Check the system log for `Certificate verify failed: unable to get local issuer certificate`. Fix: ensure `ssl_verify_upstream_trusted_ca` points to system CA store in `proxy.rs`.

#### 502 Bad Gateway from mitmproxy
mitmproxy cannot verify upstream server's TLS certificate. The standalone mitmproxy binary bundles its own CA store which may be incomplete. The runner passes `ssl_verify_upstream_trusted_ca=/etc/ssl/certs/ca-certificates.crt` to use the host's system CA store instead.

#### No network log file
If `/var/lib/vm0-runner/logs/network-<run-id>.jsonl` doesn't exist, mitmproxy didn't intercept the traffic at HTTP level. Check:
1. Is the VM registered in proxy registry? (`sudo cat /var/lib/vm0-runner/runners/<name>/proxy-registry.json`)
2. Are iptables rules redirecting the VM's subnet to the correct mitmproxy port?

#### Job stuck / not picked up
In local mode, runner watches `/var/lib/vm0-runner/groups/<group>/` for `.job` files. Check:
1. Is the runner service running? `systemctl status vm0-runner-<name>`
2. Is it in local mode? Check for `--local` in the service command

## Key Files

| File | Purpose |
|------|---------|
| `scripts/dev-runner.sh` | Build, deploy, submit, exec commands |
| `crates/runner/src/profile.rs` | Profile definitions (vCPU, memory) |
| `crates/runner/src/resource_budget.rs` | Concurrency admission control |
| `crates/runner/src/cmd/local/submit.rs` | Local file queue job submission |
| `crates/runner/src/cmd/exec.rs` | Execute command in running VM |
| `crates/runner/src/proxy.rs` | mitmproxy lifecycle and registry |
| `crates/runner/mitm-addon/src/mitm_addon.py` | mitmproxy addon (firewall, logging) |
| `crates/guest-mock-claude/src/main.rs` | Mock Claude (executes prompt as bash) |
| `crates/guest-agent/src/env.rs` | `USE_MOCK_CLAUDE` env var handling |
