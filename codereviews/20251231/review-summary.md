# PR #851 Code Review Summary

**PR Title:** feat: implement @vm0/runner MVP (Phase 2-5)
**Author:** lancy
**Commits:** 17
**Files Changed:** 30

## Overview

This PR implements the full MVP of the `@vm0/runner` package - a self-hosted runner for VM0 agents with Firecracker microVM support. It includes:

- **Phase 2**: Runner registration and job polling API endpoints
- **Phase 3**: Job claiming, execution context, and completion reporting
- **Phase 4**: Firecracker VM lifecycle management (client, network, SSH)
- **Phase 5**: Agent execution with bootstrap script injection

## Code Quality Assessment

### ✅ Good Practices Observed

1. **Static Imports Only** - No dynamic `import()` statements found
2. **Proper Type Safety** - Uses Zod schemas for runtime validation with inferred TypeScript types
3. **No `any` Types** - All types are properly defined throughout
4. **No Lint/Type Suppressions** - No `@ts-ignore`, `eslint-disable`, or similar comments
5. **Fail-Fast Error Handling** - Most errors are thrown with clear messages
6. **Clean Architecture** - Good separation between API client, VM management, and execution
7. **Meaningful E2E Tests** - Tests verify actual runner behavior with stub mode

### ⚠️ Issues Found

1. **Fallback Pattern in `api.ts`** (line 68-71)
   ```typescript
   async function getBaseUrl(): Promise<string> {
     const apiUrl = await getApiUrl();
     return apiUrl || "https://www.vm0.ai";
   }
   ```
   - Per bad-smell.md #13, this violates "Fail Fast" principle
   - Should throw an error if API URL is not configured instead of falling back
   - **Recommendation**: Fail explicitly when `apiUrl` is null/undefined

### ✅ Timer/Delay Analysis

The PR uses delays in the following places, all of which are **legitimate use cases**:

| Location | Purpose | Assessment |
|----------|---------|------------|
| `auth.ts` | OAuth device flow polling | ✅ Required for device auth spec |
| `poll/route.ts` | Long-polling for jobs | ✅ Standard long-poll pattern |
| `start.ts` | Concurrent job management | ✅ Rate limiting |
| `executor.ts` | SSH readiness wait | ✅ VM boot time |

### 📝 Architecture Notes

**Firecracker Integration:**
- `client.ts`: HTTP-over-Unix-socket API client
- `network.ts`: TAP device + bridge (vm0br0) + NAT setup
- `vm.ts`: Full VM lifecycle (create, configure, boot, stop)
- `ssh.ts`: Host-guest communication via SSH

**Job Execution Flow:**
1. Runner registers with server
2. Long-polls for pending jobs
3. Claims job (gets execution context + sandbox token)
4. Starts Firecracker VM
5. Injects Python bootstrap script via SSH
6. Bootstrap runs Claude CLI and calls completion API

**Stub Mode:**
- `stub_mode: true` in config skips Firecracker entirely
- Used for CI testing until rootfs is production-ready
- Good design for testing infrastructure independently

## Test Coverage

| Component | Test Coverage |
|-----------|---------------|
| Runner CLI | E2E tests in `t01-runner-cli.bats` |
| Job Flow | E2E tests in `t02-experimental-runner-e2e.bats` |
| Config Validation | Unit tests + E2E dry-run |
| API Endpoints | Tested via E2E runner flow |

## API Contracts Added

- `POST /api/runners/register` - Register/update runner
- `GET /api/runners/poll` - Long-poll for jobs
- `POST /api/runners/jobs/{id}/claim` - Claim job for execution
- `experimental_runner` field in agent compose schema

## Database Changes

- New `runners` table for runner registration
- Added `runner_group`, `runner_id` fields to `agent_runs`

## Verdict

**✅ APPROVED with minor suggestion**

The implementation is solid and follows project conventions well. The only issue is the fallback URL pattern in `api.ts` which should be addressed:

```typescript
// Current (bad)
return apiUrl || "https://www.vm0.ai";

// Recommended (fail fast)
if (!apiUrl) {
  throw new Error("API URL not configured. Run 'vm0-runner setup' first.");
}
return apiUrl;
```

This is a minor issue and can be addressed in a follow-up PR.
