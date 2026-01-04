# Code Review: PR #851 - @vm0/runner MVP with Firecracker Execution

**PR Title:** feat(runner): implement @vm0/runner MVP with firecracker execution
**Author:** lancy
**Files Changed:** 72
**Commits:** 100
**Diff Size:** ~9645 lines

## Overview

This PR implements the @vm0/runner package, a self-hosted runner that executes agent jobs in Firecracker microVMs. This is a significant feature that allows users to run agents on their own infrastructure instead of relying on E2B sandboxes.

## Architecture Summary

### Components Implemented

1. **Runner CLI** (`apps/runner/`)
   - `start` command with polling loop and job execution
   - Configuration via `runner.yaml` (zod validation)
   - Concurrent job support with configurable limit

2. **Firecracker Integration** (`lib/firecracker/`)
   - VM lifecycle management (create, configure, start, stop)
   - Network setup with TAP devices and NAT
   - SSH-based command execution in VMs

3. **Server APIs** (`apps/web/app/api/runners/`)
   - `/register` - Runner registration
   - `/poll` - Job polling (POST to avoid CDN caching)
   - `/jobs/[id]/claim` - Job claiming with atomic update

4. **Database Schema** (`db/schema/runner.ts`)
   - `runners` table for runner registration
   - `runner_job_queue` for job distribution with encrypted secrets

5. **E2E Tests** (`e2e/tests/03-experimental-runner/`)
   - 7 test files covering runner lifecycle, checkpoints, sessions, telemetry

## Positive Observations

1. **Good separation of concerns** - Clean module boundaries between VM management, networking, API client, and executor
2. **Comprehensive E2B parity** - Scripts maintain compatibility with existing E2B sandbox execution
3. **Proper security** - Secrets are encrypted in the job queue (AES-256-GCM)
4. **Graceful shutdown** - Runner waits for active jobs before stopping
5. **Concurrency control** - Proper job tracking with configurable limits
6. **Atomic job claiming** - Uses database-level atomicity to prevent race conditions

## Issues Found

### 1. Debug Logging Left in Production Code (Medium)

**Location:** `apps/web/app/api/runners/poll/route.ts:24-28`

```typescript
log.warn("Poll request received", {
  hasAuthHeader: !!authHeader,
  authHeaderPrefix: authHeader?.substring(0, 20) ?? "none",
  bodyGroup: body.group,
});
```

Using `log.warn` for routine debug logging will pollute production logs. This should be `log.debug`.

### 2. Hardcoded Polling Interval (Low)

**Location:** `apps/runner/src/commands/start.ts:140`

```typescript
await new Promise((resolve) => setTimeout(resolve, 30000));
```

The 30-second polling interval is hardcoded. Consider making it configurable in `runner.yaml`.

### 3. Missing Error Recovery in Job Completion (Medium)

**Location:** `apps/runner/src/commands/start.ts:53-61`

When job completion reporting fails, the error is only logged but no retry mechanism exists. Jobs might silently fail to report completion.

### 4. Potential Memory Leak in Job Promises (Low)

**Location:** `apps/runner/src/commands/start.ts:121`

```typescript
const jobPromises = new Set<Promise<void>>();
```

While promises are removed in `finally`, if the runner crashes mid-job, promises won't be cleaned up. Not critical but worth noting.

### 5. Missing Health Check Endpoint (Low)

The runner registers with "online" status but there's no periodic heartbeat to maintain this status. Long-running runners will show stale "online" status even if they crash.

## Suggestions for Future Improvement

1. **Add runner heartbeat** - Periodic heartbeat to update `lastHeartbeatAt` and detect dead runners
2. **Configurable timeouts** - SSH connection timeout, VM boot timeout should be configurable
3. **Metrics/observability** - Add Prometheus metrics for job execution times, success rates
4. **Resource cleanup cron** - Expired jobs in `runner_job_queue` need cleanup mechanism

## Testing Coverage

The E2E tests cover:

- Runner CLI validation
- Full E2E flow with runner execution
- Checkpoint/resume functionality
- Session management
- Environment variable expansion
- Artifact mounting
- Telemetry upload

Test coverage appears comprehensive for the MVP.

## Conclusion

This is a well-structured implementation of a complex feature. The code follows project conventions, has proper error handling for most cases, and includes comprehensive E2E tests. The issues found are minor and don't block the PR.

**Recommendation:** Approve with minor suggestions for follow-up cleanup.
