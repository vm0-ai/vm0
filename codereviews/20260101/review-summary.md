# PR #851 Code Review Summary

## Overview

This PR implements the @vm0/runner MVP, enabling self-hosted runner support with Firecracker VM execution.

## Review Against Bad Code Smell Criteria

### 1. Mock Analysis ✅
- **No mocks in production code**
- E2E tests use real implementations via BATS shell testing
- Tests interact with actual deployed services

### 2. Test Coverage ✅
- Comprehensive E2E tests for runner CLI commands
- Full flow tests for experimental_runner execution
- Validation tests for compose format

### 3. Error Handling ✅
- **Fail-fast pattern properly implemented**
- Config validation throws when server URL or token missing
- No silent fallbacks to default values

### 4. Interface Changes ✅
- New `experimental_runner` field in agent compose schema
- New runner registration, poll, claim, and complete API endpoints
- New database tables for runners and runner fields on agent_runs
- All changes are additive, no breaking changes

### 5. Timer and Delay Analysis ⚠️
Timer/delay usage in this PR:

| Location | Pattern | Justification |
|----------|---------|---------------|
| `vsock.ts` | `waitUntilReachable()` with interval | **Legitimate**: Polling for VM agent readiness |
| `client.ts` | `waitUntilReady()` with interval | **Legitimate**: Polling for Firecracker API socket |
| `start.ts` | `Promise.race()` for job completion | **Legitimate**: Concurrency management |
| E2E tests | `sleep 3`, `sleep 5` | **Acceptable**: Test setup waiting for async operations |

All delay patterns are for legitimate async coordination (VM startup, socket readiness), not artificial waits to work around timing issues.

### 6. Dynamic Imports ✅
- No dynamic `import()` statements found
- All imports are static at file top

### 7. Database Mocking ✅
- Web tests use real database connections
- No `globalThis.services` mocking

### 8. Test Mock Cleanup ✅
- N/A - Tests use BATS shell framework, not vitest

### 9. TypeScript `any` Type ✅
- No `any` types found in new code
- Proper typing throughout

### 10. Artificial Delays in Tests ⚠️
- E2E tests have `sleep` commands for setup
- These are bash-level waits for async operations, acceptable for E2E

### 11. Hardcoded URLs ✅
- No hardcoded URLs in production code
- Server URL and token now in `runner.yaml` config file
- Per-runner configuration enables multi-tenant deployment

### 12. Direct Database Operations ✅
- N/A - Tests use CLI commands, not direct DB operations

### 13. Fallback Patterns ✅
- Config schema enforces required fields via Zod validation
- No `||` fallback to default URLs in critical paths

### 14. Lint/Type Suppressions ✅
- No `eslint-disable`, `@ts-ignore`, or similar comments

### 15. Test Quality ✅
- Tests verify real behavior, not mocks
- No over-testing of error status codes
- E2E tests exercise full integration flow

## Architecture Highlights

### Configuration Model (Updated)
- **Removed**: `setup` command, `~/.vm0/runner-token.json` global token storage
- **Added**: `server.url` and `server.token` fields in `runner.yaml`
- **Benefit**: One Metal machine can run multiple runners connecting to different servers (e.g., different PR preview deployments)

Example `runner.yaml`:
```yaml
name: e2e-test-runner
group: e2e/test-runner-$$
server:
  url: https://vm0-xxx-preview.vercel.app
  token: eyJhbGciOiJIUzI1NiIs...
sandbox:
  max_concurrent: 1
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
```

### Vsock Communication
- Uses Firecracker's native host-guest communication
- Higher performance than SSH
- No network stack overhead
- Proper timeout handling

### VM Lifecycle Management
- Clean VM creation, configuration, and cleanup
- TAP network device management
- Guest CID allocation

### Concurrency Model
- Promise-based job tracking with `Set<Promise<void>>`
- `max_concurrent` configuration enforced
- Graceful shutdown with job completion waiting

## Recent Changes (Server Config Refactor)

| Change | Rationale |
|--------|-----------|
| Removed `setup` command | No longer need device flow auth - token goes in config |
| Removed `token.ts`, `auth.ts` | Global token storage removed |
| Added `server` field to config schema | Self-contained per-runner configuration |
| Updated API functions | Accept `ServerConfig` parameter instead of reading from token file |
| Updated E2E tests | Write full `runner.yaml` with server credentials |

## Verdict

**APPROVED** ✅

The implementation is solid and follows project conventions well. All identified issues from previous reviews have been addressed:

1. ~~Fallback pattern~~ → Fixed with fail-fast config validation
2. ~~SSH implementation~~ → Replaced with vsock
3. ~~Stub mode in E2E~~ → Removed, full Firecracker execution
4. ~~Delay patterns~~ → Replaced with Promise-based waiting where possible
5. ~~Global token storage~~ → Moved to per-runner `runner.yaml` config

The remaining timer usage is legitimate for async VM coordination and cannot be eliminated without fundamentally changing the architecture.
